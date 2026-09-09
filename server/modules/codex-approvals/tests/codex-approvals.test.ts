import assert from 'node:assert/strict';
import test from 'node:test';
import { codexApprovals } from '../index.js';
test('Codex approvals wait for one human decision and are bound to a session', async () => {
  const events: Record<string, unknown>[] = [];
  const release = codexApprovals.bind('thread-one', 'app-one', event => events.push(event));
  try {
    const response = codexApprovals.request('thread-one', 'item/commandExecution/requestApproval', { command: 'cat attachment.txt' });
    assert.ok(response); assert.equal(codexApprovals.list('app-other').length, 0);
    let settled = false; void response.then(() => settled = true); await Promise.resolve(); assert.equal(settled, false);
    const id = String(events[0].requestId);
    codexApprovals.resolve('foreign', { allow: true }); assert.equal(codexApprovals.list('app-one').length, 1);
    codexApprovals.resolve(id, { allow: true }); assert.deepEqual(await response, { decision: 'accept' });
    codexApprovals.resolve(id, { allow: false }); assert.equal(codexApprovals.list('app-one').length, 0);
    const rejected = codexApprovals.request('thread-one', 'item/fileChange/requestApproval', { changes: ['one.txt'] });
    release(); assert.deepEqual(await rejected, { decision: 'decline' });
    assert.equal(codexApprovals.request('unknown', 'item/fileChange/requestApproval', {}), null);
  } finally { release(); }
});
test('Codex question IDs remain server owned and answers are translated', async () => {
  const release = codexApprovals.bind('question-thread', 'question-app', () => {});
  try {
    const response = codexApprovals.request('question-thread', 'item/tool/requestUserInput', { questions: [{ id: 'stable-id', question: 'Which one?', options: [{ label: 'A' }] }] });
    const item = codexApprovals.list('question-app')[0];
    codexApprovals.resolve(String(item.requestId), { allow: true, updatedInput: { answers: { 'Which one?': 'A', unrelated: 'B' } } });
    assert.deepEqual(await response, { answers: { 'stable-id': { answers: ['A'] } } });
  } finally { release(); }
});
