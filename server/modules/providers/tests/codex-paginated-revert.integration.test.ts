import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
// Production transport and its history-reader registration; no model calls.
// eslint-disable-next-line boundaries/no-unknown
import '../../../openai-codex.js';
// eslint-disable-next-line boundaries/no-unknown
import { getCodexAppServer, stopCodexAppServer } from '../../../services/codex-app-server.service.js';
import { CodexSessionsProvider } from '../list/codex/codex-sessions.provider.js';
import { rewindCodexTurn } from '../services/codex-rewind.service.js';
import { markCodexRevertedHistory } from '../services/codex-reverted-history.service.js';

test('real Codex paginated edits preserve retained history across new rollout, repeated edit and process restart',
  { skip: process.env.MC_REAL_CODEX_TEST !== '1' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(),'codex-paginated-revert-'));
  const saved = {CODEX_HOME:process.env.CODEX_HOME, DATABASE_PATH:process.env.DATABASE_PATH, MC_DISABLE:process.env.MC_DISABLE};
  const threadId='01993edf-5df0-7000-a000-000000000001';
  const turns=['01993edf-5df0-7000-a000-000000000002','01993edf-5df0-7000-a000-000000000003'];
  const rollout=path.join(root,'sessions','2026','09','13',`rollout-2026-09-13T10-00-00-${threadId}.jsonl`);
  try {
    process.env.CODEX_HOME=root;process.env.DATABASE_PATH=path.join(root,'app.db');process.env.MC_DISABLE='1';
    closeConnection();await initializeDatabase();
    await mkdir(path.dirname(rollout),{recursive:true});
    const entries: any[]=[{type:'session_meta',payload:{id:threadId,timestamp:'2026-09-13T10:00:00Z',cwd:root,originator:'codex_cli_rs',cli_version:'0.153.4',source:'cli',model_provider:'openai',history_mode:'paginated'}}];
    for(const [index,turnId] of turns.entries()) entries.push(
      {type:'event_msg',payload:{type:'task_started',turn_id:turnId}},
      {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:`Question ${index}`}]}},
      {type:'event_msg',payload:{type:'item_completed',thread_id:threadId,turn_id:turnId,item:{type:'UserMessage',id:`user-${index}`,content:[{type:'text',text:`Question ${index}`,text_elements:[]},{type:'local_image',path:`/tmp/fixture-${index}.png`}]},started_at_ms:0,completed_at_ms:1}},
      {type:'response_item',payload:{type:'message',id:`answer-${index}`,role:'assistant',content:[{type:'output_text',text:`Answer ${index}`}]}},
      {type:'event_msg',payload:{type:'item_completed',thread_id:threadId,turn_id:turnId,item:{type:'AgentMessage',id:`answer-${index}`,content:[{type:'Text',text:`Answer ${index}`}],phase:'final_answer'},started_at_ms:1,completed_at_ms:2}},
      {type:'event_msg',payload:{type:'task_complete',turn_id:turnId,last_agent_message:`Answer ${index}`}},
    );
    await writeFile(rollout,entries.map((entry,ordinal)=>JSON.stringify({timestamp:'2026-09-13T10:00:00Z',ordinal,...entry})).join('\n')+'\n');
    const appId=sessionsDb.createSession(threadId,'codex',root,'Fixture',undefined,undefined,rollout);
    let server=await getCodexAppServer();
    await server.request('thread/resume',{threadId,cwd:root,approvalPolicy:'never',excludeTurns:true});
    await assert.rejects(server.request('thread/rollback',{threadId,numTurns:1}),/paginated threads do not support thread\/rollback/);
    const original=await readFile(rollout,'utf8');
    assert.equal(await rewindCodexTurn((method,params)=>server.request(method,params),threadId,`codex-turn-${turns[1]}`,()=>markCodexRevertedHistory(threadId)), 'paginated');
    assert.equal(await readFile(rollout,'utf8'),original,'Provider leaves superseded rollout intact');
    const adapter=new CodexSessionsProvider();
    let history=await adapter.fetchHistory(appId);
    assert.deepEqual(history.messages.filter(m=>m.kind==='text').map(m=>m.content),['Question 0','Answer 0']);
    assert.equal(history.messages.find(m=>m.role==='user')?.uuid,`codex-turn-${turns[0]}`);
    assert.deepEqual(history.messages.find(m=>m.role==='user')?.images,[{path:'/tmp/fixture-0.png'}]);
    assert.ok(!JSON.stringify(history).includes('fixture-1.png'));
    stopCodexAppServer();
    history=await adapter.fetchHistory(appId);
    assert.deepEqual(history.messages.filter(m=>m.kind==='text').map(m=>m.content),['Question 0','Answer 0'],'Restart must not restore discarded turn');
    server=await getCodexAppServer();
    await server.request('thread/resume',{threadId,cwd:root,approvalPolicy:'never',excludeTurns:true});
    await rewindCodexTurn((method,params)=>server.request(method,params),threadId,`codex-turn-${turns[0]}`,()=>markCodexRevertedHistory(threadId));
    assert.equal((await adapter.fetchHistory(appId)).messages.length,0,'First-turn revert clears all conversation');
  } finally {
    stopCodexAppServer();closeConnection();
    for(const [key,value] of Object.entries(saved)) { if(value===undefined) delete process.env[key];else process.env[key]=value; }
    await rm(root,{recursive:true,force:true});
  }
});
