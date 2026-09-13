import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
// These integration tests exercise the legacy runtime's actual wire output.
// eslint-disable-next-line boundaries/no-unknown
import { queryCodex } from '../../../openai-codex.js';
// eslint-disable-next-line boundaries/no-unknown
import { stopCodexAppServer } from '../../../services/codex-app-server.service.js';
// eslint-disable-next-line boundaries/no-unknown
import { __clearTaskContinuationState, __setTaskLedgerReader } from '../../../services/task-continuation.js';

test('failed Codex turns preserve the provider explanation and a policy block cannot trigger a continuation', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-terminal-error-'));
  const executable = path.join(dir, 'fake-codex');
  const capture = path.join(dir, 'requests.jsonl');
  const oldPath = process.env.VIBESPACE_CODEX_PATH;
  const explanation = 'This request was blocked by our safety systems. Reason: Potentially unintended activity.';
  const events: Array<Record<string, unknown>> = [];
  try {
    await writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(capture)}, line + '\\n');
  if (m.method === 'initialize') send({id:m.id,result:{userAgent:'fake'}});
  else if (m.method === 'thread/resume' || m.method === 'thread/start') send({id:m.id,result:{thread:{id:'failure-thread'}}});
  else if (m.method === 'turn/start') {
    send({id:m.id,result:{turn:{id:'turn-1',status:'inProgress'}}});
    send({method:'turn/completed',params:{threadId:'failure-thread',turn:{id:'turn-1',status:'failed',error:{message:${JSON.stringify(explanation)},codexErrorInfo:'misalignmentPolicyViolation'}}}});
  }
});
`);
    await chmod(executable, 0o755);
    process.env.VIBESPACE_CODEX_PATH = executable;
    __clearTaskContinuationState();
    __setTaskLedgerReader('codex', () => ({open:[{id:'1',subject:'unfinished task',status:'in_progress'}],activity:1}));
    await queryCodex('Fixture request', {sessionId:'failure-thread',cwd:dir,model:'gpt-6-astra'}, {
      isWebSocketWriter:true, send(event: Record<string, unknown>) { events.push(event); }, setSessionId() {},
    });
    const failure = events.findIndex(event => event.kind === 'error');
    const completion = events.findIndex(event => event.kind === 'complete');
    assert.ok(failure >= 0 && completion > failure);
    assert.equal(events[failure].content, explanation);
    assert.equal(events[completion].success, false);
    assert.equal(events.filter(event => event.kind === 'complete').length, 1);
    const requests = (await readFile(capture,'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(requests.filter(request => request.method === 'turn/start').length, 1);
  } finally {
    stopCodexAppServer();
    __setTaskLedgerReader('codex', null); __clearTaskContinuationState();
    if (oldPath === undefined) delete process.env.VIBESPACE_CODEX_PATH;
    else process.env.VIBESPACE_CODEX_PATH = oldPath;
    await rm(dir,{recursive:true,force:true});
  }
});

for (const rejected of [false, true]) {
  test(`Codex edit ${rejected ? 'stops on rejected rollback' : 'rolls back before starting replacement without old image'}`, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-edit-runtime-'));
    const executable = path.join(dir, 'fake-codex');
    const capture = path.join(dir, 'requests.jsonl');
    const oldPath = process.env.VIBESPACE_CODEX_PATH;
    const events: Array<Record<string, unknown>> = [];
    try {
      await writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line); fs.appendFileSync(${JSON.stringify(capture)},line+'\\n');
 if(m.method==='initialize') send({id:m.id,result:{userAgent:'fake'}});
 else if(m.method==='thread/resume'||m.method==='thread/read') send({id:m.id,result:{thread:{id:'edit-thread',turns:[{id:'keep',status:'completed'},{id:'replace',status:'failed'}]}}});
 else if(m.method==='thread/rollback') send(${rejected ? "{id:m.id,error:{code:-32000,message:'Rollback rejected'}}" : "{id:m.id,result:{thread:{id:'edit-thread',turns:[{id:'keep',status:'completed'}]}}}"});
 else if(m.method==='turn/start') {
  send({id:m.id,result:{turn:{id:'replacement',status:'inProgress'}}});
  send({method:'turn/completed',params:{threadId:'edit-thread',turn:{id:'replacement',status:'failed',error:{message:'Fixture terminal error'}}}});
 }
});
`);
      await chmod(executable, 0o755); process.env.VIBESPACE_CODEX_PATH = executable;
      __clearTaskContinuationState(); __setTaskLedgerReader('codex', () => ({open:[],activity:0}));
      await queryCodex('Explain the title', { sessionId:'edit-thread', cwd:dir, model:'gpt-6-astra', rewind:'codex-turn-replace', images:[], files:[] }, {
        isWebSocketWriter:true, send(event: Record<string, unknown>) { events.push(event); }, setSessionId() {},
      });
      const calls = (await readFile(capture,'utf8')).trim().split('\n').map(line => JSON.parse(line));
      const methods = calls.map(call => call.method);
      assert.deepEqual(calls.find(call => call.method === 'thread/rollback').params, {threadId:'edit-thread', numTurns:1});
      if (rejected) {
        assert.ok(!methods.includes('turn/start'));
        assert.ok(events.some(event => event.kind === 'error' && event.content === 'Rollback rejected'));
      } else {
        assert.ok(methods.indexOf('thread/rollback') < methods.indexOf('turn/start'));
        const input = calls.find(call => call.method === 'turn/start').params.input;
        assert.deepEqual(input, [{type:'text',text:'Explain the title'}]);
        assert.ok(events.some(event => event.kind === 'native.session-state'));
      }
      assert.equal(events.filter(event => event.kind === 'complete').length, 1);
    } finally {
      stopCodexAppServer(); __setTaskLedgerReader('codex', null); __clearTaskContinuationState();
      if (oldPath === undefined) delete process.env.VIBESPACE_CODEX_PATH; else process.env.VIBESPACE_CODEX_PATH = oldPath;
      await rm(dir, {recursive:true,force:true});
    }
  });
}
