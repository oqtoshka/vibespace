import assert from 'node:assert/strict';
import test from 'node:test';
import { opencodeQuestions } from '../services/opencode-questions.service.js';

test('OpenCode questions reach the shared prompt UI and return ordered answers', async () => {
  const events: Record<string, unknown>[] = [];
  const replies: unknown[] = [];
  const binding = opencodeQuestions.bind('ses_one', event => events.push(event), async (id, answers) => { replies.push({ id, answers }); });
  binding.request({ id: 'que_one', sessionID: 'ses_other', questions: [] });
  assert.equal(events.length, 0);
  binding.request({ id: 'que_one', sessionID: 'ses_one', questions: [
    { question: 'Which news?', options: [{ label: 'World' }] },
    { question: 'Regions?', options: [{ label: 'Europe' }, { label: 'Asia' }], multiple: true },
  ] });
  assert.equal(events[0].toolName, 'AskUserQuestion');
  opencodeQuestions.resolve(String(events[0].requestId), { allow: true, updatedInput: { answers: { 'Which news?': 'в мире', 'Regions?': 'Europe, Asia' } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(replies, [{ id: 'que_one', answers: [['в мире'], ['Europe', 'Asia']] }]);
  assert.equal(events.at(-1)?.kind, 'permission_cancelled');
  binding.close();
});

test('failed answers stay retryable and stopping clears a pending prompt', async () => {
  const events: Record<string, unknown>[] = [];
  let attempts = 0;
  const binding = opencodeQuestions.bind('ses_retry', event => events.push(event), async () => { if (++attempts === 1) throw new Error('offline'); });
  binding.request({ id: 'que_retry', sessionID: 'ses_retry', questions: [{ question: 'Continue?', options: [] }] });
  const key = String(events[0].requestId);
  opencodeQuestions.resolve(key, { allow: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.at(-1)?.kind, 'permission_request');
  opencodeQuestions.resolve(key, { allow: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 2);
  assert.equal(events.at(-1)?.kind, 'permission_cancelled');
  binding.request({ id: 'que_stop', sessionID: 'ses_retry', questions: [] });
  binding.close();
  assert.equal(events.at(-1)?.requestId, 'opencode-question-que_stop');
  assert.equal(events.at(-1)?.kind, 'permission_cancelled');
});
