import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { registerTaskLedgerSource } from '../../../shared/index.js';
import { __clearTaskContinuationState } from '../../task-continuation/index.js';
import { initializeDatabase, closeConnection } from '../../database/index.js';
// eslint-disable-next-line boundaries/no-unknown -- Exercise the actual legacy Codex terminal continuation boundary.
import { queryCodex, injectCodexMessage } from '../../../openai-codex.js';
// eslint-disable-next-line boundaries/no-unknown -- Own and close the fixture app-server transport.
import { stopCodexAppServer } from '../../../services/codex-app-server.service.js';

test('actual Codex entry captures prompt before tools and terminal seam performs one missing-card repair', { timeout: 15000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'codex-card-reporting-'));
  const executable = path.join(dir, 'fake-codex'), capture = path.join(dir, 'requests.jsonl');
  const previous = process.env.VIBESPACE_CODEX_PATH;
  const events: Array<Record<string, unknown>> = [], boundaries: string[] = [];
  const human = 'Mission Control thread 11111111-1111-4111-8111-111111111111\nFull exact prompt';
  const second = 'Mission Control thread 22222222-2222-4222-8222-222222222222\nSteered follow-up';
  const seenBeginIds = new Set<string>();
  let steer: Promise<unknown> | undefined;
  let checkpoint: { turnId: string; prompt: string } | undefined;
  const unregister = registerTaskLedgerSource((context) => {
    if (context.sessionId !== 'reporting-thread') return null;
    if (context.phase === 'begin' && !seenBeginIds.has(context.turnId!)) {
      seenBeginIds.add(context.turnId!);
      boundaries.push(context.prompt!);
      if (!context.prompt?.startsWith('[session supervisor]')) checkpoint = { turnId: context.turnId!, prompt: context.prompt === second ? 'Reply to second thread 22222222-2222-4222-8222-222222222222' : 'Reply to exact reporting thread' };
    }
    return { listName: 'card plan', guidance: '', open: [], activity: 0, completion: checkpoint };
  });
  try {
    await initializeDatabase();
    await writeFile(executable, `#!/usr/bin/env node
const fs=require('node:fs'); let serial=0;
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
const m=JSON.parse(line); fs.appendFileSync(${JSON.stringify(capture)},line+'\\n');
if(m.method==='initialize') send({id:m.id,result:{}});
else if(m.method==='config/read') send({id:m.id,result:{config:{mcp_servers:{}}}});
else if(m.method==='thread/resume'||m.method==='thread/start') send({id:m.id,result:{thread:{id:'reporting-thread'}}});
else if(m.method==='thread/unsubscribe') send({id:m.id,result:{}});
else if(m.method==='turn/start') {
 const id='turn-'+(++serial); send({id:m.id,result:{turn:{id,status:'inProgress'}}});
 send({method:'item/completed',params:{threadId:'reporting-thread',turnId:id,item:{type:'agentMessage',id:'answer-'+id,text:'Fixture chat '+serial,phase:'final_answer'}}});
 if(serial>1) send({method:'turn/completed',params:{threadId:'reporting-thread',turn:{id,status:'completed'}}});
}
else if(m.method==='turn/steer') {
 send({method:'item/started',params:{threadId:'reporting-thread',turnId:'turn-1',item:{type:'userMessage',clientId:m.params.clientUserMessageId}}});
 send({method:'item/completed',params:{threadId:'reporting-thread',turnId:'turn-1',item:{type:'userMessage',clientId:m.params.clientUserMessageId}}});
 send({id:m.id,result:{}});
 send({method:'turn/completed',params:{threadId:'reporting-thread',turn:{id:'turn-1',status:'completed'}}});
}
});
`);
    await chmod(executable, 0o755); process.env.VIBESPACE_CODEX_PATH = executable;
    __clearTaskContinuationState();
    await queryCodex(human, { sessionId: 'reporting-thread', cwd: dir, model: 'gpt-6-astra' }, {
      isWebSocketWriter: true, send(event: Record<string, unknown>) {
        events.push(event);
        if (event.content === 'Fixture chat 1') {
          checkpoint = undefined; // First thread has been answered, then a different human request arrives.
          steer = injectCodexMessage('reporting-thread', second, { clientUserMessageId: 'steer-1', cwd: dir });
        }
      }, setSessionId() {},
    });
    await steer;
    const calls = (await readFile(capture, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const turns = calls.filter(call => call.method === 'turn/start');
    assert.equal(turns.length, 2, 'one actual terminal continuation, even while checkpoint remains missing');
    assert.equal(boundaries[0], human, 'begin sees original full prompt before execution');
    assert.equal(boundaries[1], second, 'accepted steer captures full next prompt once despite duplicate lifecycle events');
    assert.equal(boundaries.length, 3);
    assert.match(boundaries[2], /^\[session supervisor\].*Missing card reporting checkpoint/);
    assert.equal(turns[0].params.input[0].text, human);
    assert.match(turns[1].params.input[0].text, /Reply to second thread 22222222-2222-4222-8222-222222222222/);
    assert.equal(events.filter(event => event.kind === 'complete').length, 1, 'completion is withheld until repair ends');
    assert.ok(events.some(event => event.kind === 'error' && /AGENT_TEXT_POLICY_VIOLATION/.test(String(event.content))), 'missing checkpoint after repair is explicit failure');
    assert.deepEqual(events.filter(event => event.kind === 'complete').map(event => event.success), [false]);
    assert.ok(events.some(event => event.content === 'Fixture chat 1'), 'post-stream repair does not claim chat suppression');
  } finally {
    unregister(); stopCodexAppServer(); __clearTaskContinuationState();
    closeConnection();
    if (previous === undefined) delete process.env.VIBESPACE_CODEX_PATH; else process.env.VIBESPACE_CODEX_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
