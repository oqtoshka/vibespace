import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { registerTaskLedgerSource, registerAgentLaunchContributor } from '../../../shared/index.js';
import { BRIEFING_REPAIRS_PER_TURN } from '../index.js';
const dbRoot = await mkdtemp(path.join(os.tmpdir(),'claude-briefing-db-'));
process.env.DATABASE_PATH = path.join(dbRoot,'auth.db');
// eslint-disable-next-line boundaries/no-unknown -- Actual persistent provider integration without any provider request.
const { queryClaudeSDK, injectClaudeMessage, abortClaudeSDKSession, __setClaudeQueryImpl, __setClaudeInputControllerImpl } = await import('../../../claude-sdk.js');
const { initializeDatabase, closeConnection } = await import('../../database/index.js');
test.before(()=>initializeDatabase());
test.after(async()=>{closeConnection();await rm(dbRoot,{recursive:true,force:true});});

for (const scenario of ['repair','repeat','missing','late','launch','plain','helper','side','silent']) test(`actual Claude stream: ${scenario}`, {timeout:15000},async()=>{
  const cwd=await mkdtemp(path.join(os.tmpdir(),'claude-briefing-'));
  const sid='claude-policy-'+scenario;
  const sent: any[]=[];const prompts: any[]=[];let present=scenario!=='late';
  const stopLaunch=registerAgentLaunchContributor(c=>scenario==='launch'&&c.sessionRole==='main'?{agentTextPolicy:'reject'}:null);
 const unregister=registerTaskLedgerSource(c=>c.sessionId===sid&&present&&scenario!=='plain'&&scenario!=='launch'? {listName:'card',guidance:'',open:[],activity:0,agentTextPolicy:'reject',...(scenario==='missing'?{completion:{turnId:'human',prompt:'reply exact threads'}}:{}),...(c.phase==='complete'&&scenario==='silent'?{turnComplete:{turnId:c.turnId!,activity:0}}:{})}:null);
  const persistent=['repeat','missing','launch'].includes(scenario);
  // Persistent violations get every repair of the turn's budget, then the turn settles idle.
  const rounds=persistent?1+BRIEFING_REPAIRS_PER_TURN:['repair','late'].includes(scenario)?2:1;
  __setClaudeQueryImpl(({prompt,options}: any)=>{
    const reader=prompt[Symbol.asyncIterator]();
    const gen=(async function*(){
      for(let round=0;round<rounds;round++){
        prompts.push((await reader.next()).value);
        present=true;
        const prose=scenario!=='silent'&&(round===0||scenario==='repeat');
        if (scenario==='silent') {
          const hook=options.hooks.PostToolUse[0].hooks[0];
          assert.match((await hook({tool_name:'Bash'})).hookSpecificOutput.additionalContext,/card is the visible output/);
          assert.deepEqual(await hook({tool_name:'Bash',agent_id:'child'}),{},'child has no main card policy hook');
        }
        yield {type:'assistant',session_id:sid,message:{role:'assistant',content:[...(prose?[{type:'text',text:round?'FORBIDDEN_AGAIN':'FORBIDDEN_INITIAL'}]:[]),{type:'tool_use',id:'card-'+round,name:'mcp__mc__reply',input:{threadId:'exact'}}]}};
        yield {type:'result',subtype:'success',session_id:sid};
      }
    })();
    (gen as any).interrupt=async()=>{}; return gen;
  });
  try{
    await queryClaudeSDK('actual incoming request',{sessionId:sid,cwd,ephemeral:scenario==='helper',sideSession:scenario==='side'?{id:'side'}:undefined},{send:(m:any)=>sent.push(m),setSessionId(){},userId:null});
    const output=sent.filter(m=>m.kind==='text'||m.kind==='stream_delta');
    assert.equal(output.some(m=>String(m.content).includes('FORBIDDEN')),['plain','helper','side'].includes(scenario));
    assert.ok(sent.some(m=>m.kind==='tool_use'));
    assert.equal(prompts.length,rounds);
    assert.ok(!sent.some(m=>m.kind==='error'),'a reporting-policy violation is never a failure');
    assert.equal(sent.find(m=>m.kind==='complete').exitCode,0);
    assert.equal(Boolean(sent.find(m=>m.kind==='complete').reportingTurnId),scenario==='silent');
    assert.equal(sent.some(m=>m.text==='agent_text_policy_exhausted'),persistent);
    for(const p of prompts.slice(1))assert.doesNotMatch(JSON.stringify(p),/ends this run/);
  }finally{stopLaunch();unregister();abortClaudeSDKSession(sid);__setClaudeQueryImpl(null);await rm(cwd,{recursive:true,force:true});}
});

test('actual persistent Claude: identical consecutive human queries require distinct host checkpoints', {timeout:15000},async()=>{
 const cwd=await mkdtemp(path.join(os.tmpdir(),'claude-identical-'));const sid='claude-identical';const ids:string[]=[];let calls=0;
 const stop=registerTaskLedgerSource(c=>{if(c.sessionId!==sid)return null;if(c.phase==='begin')ids.push(c.turnId!);return {listName:'card',guidance:'',open:[],activity:0,agentTextPolicy:'reject'};});
 __setClaudeQueryImpl(({prompt}:any)=>{calls++;const reader=prompt[Symbol.asyncIterator]();const gen=(async function*(){for(let i=0;i<2;i++){await reader.next();yield {type:'assistant',session_id:sid,message:{role:'assistant',content:[{type:'tool_use',id:'card-'+i,name:'mcp__mc__reply',input:{threadId:'exact'}}]}};yield {type:'result',subtype:'success',session_id:sid};}})();(gen as any).interrupt=async()=>{};return gen;});
 try {const ws={send(){},setSessionId(){},userId:null};await queryClaudeSDK('identical',{sessionId:sid,cwd},ws);const first=ids.at(-1);await queryClaudeSDK('identical',{sessionId:sid,cwd},ws);assert.equal(calls,1,'persistent SDK instance reused');assert.notEqual(ids.at(-1),first,'new human request gets new checkpoint despite identical text');}
 finally {stop();abortClaudeSDKSession(sid);__setClaudeQueryImpl(null);await rm(cwd,{recursive:true,force:true});}
});

test('actual rejected Claude steer preserves current human checkpoint', {timeout:15000},async()=>{
 const cwd=await mkdtemp(path.join(os.tmpdir(),'claude-rejected-steer-'));const sid='claude-rejected-steer';const ids:string[]=[];let controller:any;
 __setClaudeInputControllerImpl((input:any)=>{controller=input;return input;});
 const stop=registerTaskLedgerSource(c=>{if(c.sessionId!==sid)return null;if(c.phase==='begin')ids.push(c.turnId!);return {listName:'card',guidance:'',open:[],activity:0,agentTextPolicy:'reject'};});
 __setClaudeQueryImpl(({prompt}:any)=>{const reader=prompt[Symbol.asyncIterator]();const gen=(async function*(){await reader.next();yield {type:'system',subtype:'init',session_id:sid,capabilities:['msg_lifecycle_v1']};yield {type:'result',subtype:'success',session_id:sid};await reader.next();})();(gen as any).interrupt=async()=>{};return gen;});
 try {await queryClaudeSDK('human',{sessionId:sid,cwd},{send(){},setSessionId(){},userId:null});const before=[...ids];controller.push=()=>false;assert.equal(await injectClaudeMessage(sid,'human'),null);assert.deepEqual(ids,before,'refused push must not rotate checkpoint');}
 finally{stop();abortClaudeSDKSession(sid);__setClaudeQueryImpl(null);__setClaudeInputControllerImpl(null);await rm(cwd,{recursive:true,force:true});}
});

test('silent briefing completion still resumes for a child notification', { timeout: 15000 }, async () => {
  const sid = 'briefing-child-completion';
  const sent: any[] = [];
  const completedIds = new Set<string>();
  let childMessage: any;
  const stop = registerTaskLedgerSource(c => {
    if (c.sessionId !== sid) return null;
    if (c.phase === 'complete') completedIds.add(c.turnId!);
    return {
    listName: 'card', guidance: '', open: [{ id: 's1', subject: 'Child result', status: 'pending', waitingOnUser: true, updatedAt: null }],
    activity: 1, agentTextPolicy: 'reject',
    ...(c.phase === 'complete' ? { turnComplete: { turnId: c.turnId!, activity: 1 } } : {}),
    };
  });
  __setClaudeQueryImpl(({ prompt }: any) => {
    const reader = prompt[Symbol.asyncIterator]();
    const gen = (async function* () {
      await reader.next();
      yield { type: 'assistant', session_id: sid, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'child-tool', name: 'Agent', input: {} }] } };
      yield { type: 'system', subtype: 'task_started', session_id: sid, task_id: 'child-task', tool_use_id: 'child-tool', task_type: 'local_agent', description: 'Child verification' };
      yield { type: 'result', subtype: 'success', session_id: sid };
      yield { type: 'system', subtype: 'task_notification', session_id: sid, task_id: 'child-task', tool_use_id: 'child-tool', status: 'completed', summary: 'Child verification ready' };
      childMessage = (await reader.next()).value;
      yield { type: 'assistant', session_id: sid, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'report', name: 'mcp__card__state', input: {} }] } };
      yield { type: 'result', subtype: 'success', session_id: sid };
    })();
    (gen as any).interrupt = async () => {};
    return gen;
  });
  try {
    await queryClaudeSDK('Delegate verification', { sessionId: sid }, { send: (m: any) => sent.push(m), setSessionId() {}, userId: null });
    const deadline = Date.now() + 8000;
    while (sent.filter(m => m.kind === 'complete').length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(sent.filter(m => m.kind === 'complete').length, 2, 'child completion opens and finishes another turn');
    assert.equal(completedIds.size, 2, 'child turn cannot reuse the prior silent completion receipt');
    assert.equal(new Set(sent.filter(m => m.kind === 'complete').map(m => m.reportingTurnId)).size, 2, 'run history carries both receipts');
    assert.match(childMessage.message.content, /Child verification ready/);
    assert.ok(!sent.some(m => m.kind === 'text' || m.text === 'agent_text_policy_exhausted'));
  } finally { stop(); abortClaudeSDKSession(sid); __setClaudeQueryImpl(null); }
});
