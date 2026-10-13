import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { registerTaskLedgerSource } from '../../../shared/index.js';
import { __clearTaskContinuationState } from '../../task-continuation/index.js';
import { initializeDatabase, closeConnection } from '../../database/index.js';
// eslint-disable-next-line boundaries/no-unknown -- Real runtime/transport policy boundary, without a provider call.
import { queryCodex, injectCodexMessage } from '../../../openai-codex.js';
// eslint-disable-next-line boundaries/no-unknown -- Close the owned executable fixture transport.
import { stopCodexAppServer } from '../../../services/codex-app-server.service.js';

type Scenario = { policy?: unknown; repeat?: boolean; providerFailure?: boolean; steer?: boolean; side?: boolean; empty?: boolean; child?: boolean; helper?: boolean; unreadable?: boolean; missing?: boolean; late?: boolean; unreadableAfterAdmission?: boolean };
async function run(scenario: Scenario) {
  const dir = await mkdtemp(path.join(tmpdir(), 'codex-agent-text-policy-'));
  const executable = path.join(dir, 'codex'), capture = path.join(dir, 'requests.jsonl');
  const previous = process.env.VIBESPACE_CODEX_PATH;
  const events: Array<Record<string, unknown>> = [], boundaries: string[] = [], roles: Array<string | undefined> = [];
  let sidecarReady = false;
  let steered = false, pendingSteer: Promise<unknown> | undefined;
  const unregister = registerTaskLedgerSource(context => {
    if (context.sessionId !== 'policy-thread') return null;
    if (scenario.late && !sidecarReady) return null;
    if (context.phase === 'begin') { boundaries.push(context.prompt!); roles.push(context.sessionRole); }
    if (scenario.unreadable || (scenario.unreadableAfterAdmission && boundaries.length > 1)) throw new Error('Fixture source unavailable');
    return { listName: 'card plan', guidance: '', open: [], activity: 0,
      // Deliberately allow malformed plugin data to exercise the public normalizer.
      agentTextPolicy: (scenario.steer && !steered ? undefined : scenario.policy) as 'reject' | undefined,
      ...(scenario.missing ? { completion: { turnId: 'actual-human', prompt: 'reply exact current threads' } } : {}) };
  });
  try {
    await initializeDatabase();
    await writeFile(executable, `#!/usr/bin/env node
const fs=require('node:fs'); const scenario=${JSON.stringify(scenario)}; let serial=0;
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
const item=(id,value)=>send({method:'item/completed',params:{threadId:'policy-thread',turnId:id,item:value}});
const finish=id=>send({method:'turn/completed',params:{threadId:'policy-thread',turn:{id,status:scenario.providerFailure?'failed':'completed',...(scenario.providerFailure?{error:{message:'Fixture transport failure'}}:{})}}});
const output=id=>{
 if(scenario.child) send({method:'item/completed',params:{threadId:'native-child-thread',turnId:id,item:{type:'agentMessage',id:'child-answer',text:'Child result for parent'}}});
 item(id,{type:'reasoning',id:'reasoning-'+id,summary:['Internal trace fixture'],content:[]});
 // A valid card tool reply precedes prose. It must not waive the behavior invariant.
 item(id,{type:'mcpToolCall',id:'reply-'+id,server:'mc',tool:'reply',arguments:{threadId:'fixture'},result:{content:[{type:'text',text:'Card reply accepted'}]},status:'completed'});
 if((serial===1||scenario.repeat)&&!scenario.child){
  send({method:'item/agentMessage/delta',params:{threadId:'policy-thread',turnId:id,itemId:'answer-'+id,delta:scenario.empty?'   ':'Do not leak this prose'}});
  item(id,{type:'agentMessage',id:'answer-'+id,text:scenario.empty?'   ':'Do not leak this prose',phase:'commentary'});
  item(id,{type:'agentMessage',id:'answer-'+id,text:scenario.empty?'   ':'Do not leak this prose',phase:'final_answer'});
 }
 finish(id);
};
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line); fs.appendFileSync(${JSON.stringify(capture)},line+'\\n');
 if(m.method==='initialize'||m.method==='thread/unsubscribe')send({id:m.id,result:{}});
 else if(m.method==='config/read')send({id:m.id,result:{config:{mcp_servers:{}}}});
 else if(m.method==='thread/resume'||m.method==='thread/start')send({id:m.id,result:{thread:{id:'policy-thread'}}});
 else if(m.method==='turn/start'){
  const id='turn-'+(++serial);send({id:m.id,result:{turn:{id,status:'inProgress'}}});
  if(scenario.steer&&serial===1) send({method:'thread/tokenUsage/updated',params:{threadId:'policy-thread',tokenUsage:{last:{inputTokens:1,outputTokens:0,totalTokens:1}}}});
  else output(id);
 } else if(m.method==='turn/steer'){
  send({method:'item/started',params:{threadId:'policy-thread',turnId:'turn-1',item:{type:'userMessage',clientId:m.params.clientUserMessageId}}});
  send({method:'item/completed',params:{threadId:'policy-thread',turnId:'turn-1',item:{type:'userMessage',clientId:m.params.clientUserMessageId}}});
  send({id:m.id,result:{}});output('turn-1');
 }
});
`);
    await chmod(executable, 0o755); process.env.VIBESPACE_CODEX_PATH = executable;
    __clearTaskContinuationState();
    const running = queryCodex('Human request', { sessionId: 'policy-thread', cwd: dir, model: 'gpt-6-astra', sideSession: scenario.side, ephemeral: scenario.helper, backgroundHelper: scenario.helper }, {
      isWebSocketWriter: true, send(event: Record<string, unknown>) { events.push(event); if (event.kind === 'tool_use') sidecarReady = true; }, setSessionId() {},
    });
    if (scenario.steer) {
      const deadline = Date.now() + 3000;
      while (!boundaries.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(boundaries.length, 1);
      steered = true;
      pendingSteer = injectCodexMessage('policy-thread', 'Second exact human request', { clientUserMessageId: 'human-steer', cwd: dir });
    }
    await running; await pendingSteer;
    const calls = (await readFile(capture, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    return { events, calls, boundaries, roles };
  } finally {
    unregister(); stopCodexAppServer(); __clearTaskContinuationState(); closeConnection();
    if (previous === undefined) delete process.env.VIBESPACE_CODEX_PATH; else process.env.VIBESPACE_CODEX_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

test('actual Codex rejects delta/completed prose after valid card reply, deduplicates and repairs once', { timeout: 15000 }, async () => {
  const { events, calls } = await run({ policy: 'reject' });
  assert.equal(calls.filter(call => call.method === 'turn/start').length, 2);
  assert.match(calls.filter(call => call.method === 'turn/start')[1].params.input[0].text, /Session behavior invariant violated/);
  assert.equal(events.filter(event => event.text === 'agent_text_policy_violation').length, 1);
  assert.ok(events.some(event => event.kind === 'tool_use' && event.toolName === 'reply' && JSON.stringify(event.result).includes('Card reply accepted')), 'accepted card tool result still streams');
  assert.ok(events.some(event => event.kind === 'thinking' && event.content === 'Internal trace fixture'), 'existing internal reasoning trace remains distinct from operator prose');
  assert.ok(!events.some(event => event.content === 'Do not leak this prose'));
  assert.deepEqual(events.filter(event => event.kind === 'complete').map(event => event.success), [true]);
});
test('actual Codex repeated prose becomes invariant error and failed terminal, never a silent successful completion', { timeout: 15000 }, async () => {
  const { events, calls } = await run({ policy: 'reject', repeat: true });
  assert.equal(calls.filter(call => call.method === 'turn/start').length, 2);
  assert.ok(events.some(event => event.kind === 'error' && /AGENT_TEXT_POLICY_VIOLATION/.test(String(event.content))));
  assert.deepEqual(events.filter(event => event.kind === 'complete').map(event => event.success), [false]);
});
test('actual Codex ordinary session prose remains accepted without capability', { timeout: 15000 }, async () => {
  const { events, calls } = await run({});
  assert.equal(calls.filter(call => call.method === 'turn/start').length, 1);
  assert.ok(events.some(event => event.content === 'Do not leak this prose'));
  assert.ok(!events.some(event => event.text === 'agent_text_policy_violation'));
});
test('malformed capability is unavailable, never treated as confirmed rejection policy', { timeout: 15000 }, async () => {
  const { events } = await run({ policy: { reject: true } });
  assert.ok(events.some(event => event.content === 'Do not leak this prose'));
  assert.ok(!events.some(event => event.text === 'agent_text_policy_violation'));
});
test('actual Codex provider failure remains error without a policy repair', { timeout: 15000 }, async () => {
  const { events, calls } = await run({ policy: 'reject', providerFailure: true });
  assert.equal(calls.filter(call => call.method === 'turn/start').length, 1);
  assert.ok(events.some(event => event.kind === 'error' && event.content === 'Fixture transport failure'));
  assert.deepEqual(events.filter(event => event.kind === 'complete').map(event => event.success), [false]);
});
test('actual Codex accepted human steer activates policy once before its next prose', { timeout: 15000 }, async () => {
  const { events, boundaries, roles } = await run({ policy: 'reject', steer: true });
  assert.equal(boundaries.filter(prompt => prompt === 'Second exact human request').length, 1);
  assert.ok(roles.every(role => role === 'main'));
  assert.ok(!events.some(event => event.content === 'Do not leak this prose'));
  assert.equal(events.filter(event => event.text === 'agent_text_policy_violation').length, 1);
});
test('side-session prose remains allowed even with a misapplied main-session capability', { timeout: 15000 }, async () => {
  const { events, calls, roles } = await run({ policy: 'reject', side: true });
  assert.equal(calls.filter(call => call.method === 'turn/start').length, 1);
  assert.ok(events.some(event => event.content === 'Do not leak this prose'));
  assert.deepEqual(roles, ['side']);
});
test('empty delta/completed events do not manufacture an agent-text violation', { timeout: 15000 }, async () => {
  const { events, calls } = await run({ policy: 'reject', empty: true });
  assert.equal(calls.filter(call => call.method === 'turn/start').length, 1);
  assert.ok(!events.some(event => event.text === 'agent_text_policy_violation'));
});
test('native child thread text cannot become a root dialogue violation or forwarded root message', { timeout: 15000 }, async () => {
  const { events, calls } = await run({ policy: 'reject', child: true });
  assert.equal(calls.filter(call => call.method === 'turn/start').length, 1);
  assert.ok(!events.some(event => event.text === 'agent_text_policy_violation' || event.content === 'Child result for parent'));
});
test('ephemeral helper neither reads a main policy nor rejects helper prose', { timeout: 15000 }, async () => {
  const { events, calls, roles } = await run({ policy: 'reject', helper: true });
  assert.equal(calls.filter(call => call.method === 'turn/start').length, 1);
  assert.deepEqual(roles, []);
  assert.ok(events.some(event => event.content === 'Do not leak this prose'));
});
test('unreadable source does not fabricate enforcement or turn ordinary prose into a failure', { timeout: 15000 }, async () => {
  const { events, calls } = await run({ policy: 'reject', unreadable: true });
  assert.equal(calls.filter(call => call.method === 'turn/start').length, 1);
  assert.ok(events.some(event => event.content === 'Do not leak this prose'));
  assert.ok(!events.some(event => event.text === 'agent_text_policy_violation'));
});
test('confirmed policy admission survives an unavailable source during its one repair', { timeout: 15000 }, async () => {
  const { events, calls } = await run({ policy: 'reject', repeat: true, unreadableAfterAdmission: true });
  assert.equal(calls.filter(call => call.method === 'turn/start').length, 2);
  assert.ok(!events.some(event => event.content === 'Do not leak this prose'));
  assert.deepEqual(events.filter(event => event.kind === 'complete').map(event => event.success), [false]);
  assert.ok(events.some(event => event.kind === 'error' && /AGENT_TEXT_POLICY_VIOLATION/.test(String(event.content))));
});

test('actual Codex re-reads first-turn admission after the card tool creates a sidecar', { timeout: 15000 }, async () => {
  const { events, calls } = await run({ policy: 'reject', late: true });
  assert.equal(calls.filter(call => call.method === 'turn/start').length, 2);
  assert.ok(!events.some(event => event.content === 'Do not leak this prose'));
  assert.deepEqual(events.filter(event => event.kind === 'complete').map(event => event.success), [true]);
});

test('actual Codex repeated missing card checkpoint shares the single policy repair budget', { timeout: 15000 }, async () => {
  const { events, calls } = await run({ policy: 'reject', missing: true });
  assert.equal(calls.filter(call => call.method === 'turn/start').length, 2);
  assert.match(calls.filter(call => call.method === 'turn/start')[1].params.input[0].text, /reply exact current threads/);
  assert.ok(events.some(event => event.kind === 'error' && /AGENT_TEXT_POLICY_VIOLATION/.test(String(event.content))));
  assert.deepEqual(events.filter(event => event.kind === 'complete').map(event => event.success), [false]);
});
