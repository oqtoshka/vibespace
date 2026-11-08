import assert from 'node:assert/strict';
import test from 'node:test';

import { NOOP_TOOL_LOOP_LIMIT, NoopToolLoopGuard } from '../index.js';

let nextId = 0;
const bash = (command: string, output = '') => ({ kind: 'tool_use', toolName: 'bash', toolInput: { command }, toolId: `call-${nextId++}`, toolResult: { content: output, isError: false } });
const card = (input: unknown, output: string) => ({ kind: 'tool_use', toolName: 'mc_status', toolInput: input, toolId: `call-${nextId++}`, toolResult: { content: output, isError: false } });

test('the limit is three consecutive no-op calls', () => {
  assert.equal(NOOP_TOOL_LOOP_LIMIT, 3);
});

test('reasoning between bash `true` calls does not hide the loop; the third stops it once', () => {
  const guard = new NoopToolLoopGuard();
  assert.equal(guard.observe({ kind: 'thinking' }), null);
  assert.equal(guard.observe(bash('true')), null);
  assert.equal(guard.observe({ kind: 'thinking' }), null);
  assert.equal(guard.observe(bash('true')), null);
  assert.equal(guard.observe({ kind: 'stream_delta' }), null);
  const reason = guard.observe(bash('true'));
  assert.match(reason!, /3 consecutive no-op tool calls/);
  assert.match(reason!, /session stays open/);
  assert.equal(guard.reason, reason);
  assert.equal(guard.observe(bash('true')), null, 'reported once');
});

test('every no-op spelling counts; a real command resets the streak', () => {
  for (const command of ['', ':', 'true;', 'true && true', 'exit 0', 'echo', "echo ''", 'sleep 0', '/usr/bin/true']) {
    const guard = new NoopToolLoopGuard();
    guard.observe(bash(command)); guard.observe(bash(command));
    assert.ok(guard.observe(bash(command)), `${JSON.stringify(command)} is a no-op`);
  }
  const guard = new NoopToolLoopGuard();
  guard.observe(bash('true')); guard.observe(bash('true'));
  assert.equal(guard.observe(bash('git status')), null);
  guard.observe(bash('true')); guard.observe(bash('true'));
  assert.equal(guard.reason, null, 'a real call in between resets the count');
  for (const command of ['sleep 30', 'echo done', 'true || rm -rf build', 'exit 1']) {
    const fresh = new NoopToolLoopGuard();
    for (let i = 0; i < 5; i++) fresh.observe(bash(command));
    assert.equal(fresh.reason, null, `${command} does something`);
  }
});

test('a card call repeated with the same input and answer is a no-op; a changed answer is progress', () => {
  const guard = new NoopToolLoopGuard();
  const unchanged = 'status working unchanged: nothing recorded. End the turn unless work remains.';
  assert.equal(guard.observe(card({ status: 'working' }, 'recorded')), null);
  assert.equal(guard.observe(card({ status: 'working' }, unchanged)), null);
  assert.equal(guard.observe(card({ status: 'working' }, unchanged)), null);
  assert.equal(guard.observe(card({ status: 'working' }, unchanged)), null);
  assert.match(guard.observe(card({ status: 'working' }, unchanged))!, /mc_status repeated unchanged/);
  const plan = new NoopToolLoopGuard();
  for (let i = 0; i < 6; i++) plan.observe(card({ steps: [] }, `revision ${i}`));
  assert.equal(plan.reason, null);
});

test('identical repeats of an ordinary tool are not judged; a re-published call id counts once', () => {
  const reads = new NoopToolLoopGuard();
  for (let i = 0; i < 6; i++) reads.observe({ kind: 'tool_use', toolName: 'read', toolInput: { filePath: 'a.ts' }, toolId: `r${i}`, toolResult: { content: 'same' } });
  assert.equal(reads.reason, null);
  const guard = new NoopToolLoopGuard();
  const once = bash('true');
  for (let i = 0; i < 5; i++) guard.observe(once);
  assert.equal(guard.reason, null);
});
