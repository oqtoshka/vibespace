import assert from 'node:assert/strict';
import test from 'node:test';
import { readTopicMemory, topicBatch, mergeTopicResponse, topicInstructions } from '../services/session-topics.service.js';

const row = (id: string, content: string) => ({ id, kind: 'text', role: 'user', content });
const reply = (topics: unknown[], kinds = ['feature'], merges: unknown[] = []) => JSON.stringify({ topics, kinds, merges });
const topic = (label: string, messageId: string, quote: string, id?: string) => ({ label, summary: label, messageId, quote, id });

test('oldest subjects survive drift and synonyms preserve earliest evidence', () => {
  const first = readTopicMemory();
  const b1 = topicBatch([row('a', 'Build session tags')], first, 1);
  const m1 = mergeTopicResponse(reply([topic('Session tags', 'a', 'Session tags')]), first, b1)!;
  assert.equal(m1.origin, 'Build session tags');
  assert.equal(m1.topics[0].firstQuote, 'session tags');
  const b2 = topicBatch([row('b', 'Fix voice recording')], m1, 2);
  const m2 = mergeTopicResponse(reply([topic('Voice recording', 'b', 'voice recording')], ['fix']), m1, b2)!;
  assert.deepEqual(m2.topics.map(t => t.label), ['Session tags', 'Voice recording']);
  assert.deepEqual(m2.kinds, ['feature', 'fix']);
  assert.match(topicInstructions(m2, b2), /Build session tags/);
  const b3 = topicBatch([row('c', 'Improve session tags')], m2, 3);
  const m3 = mergeTopicResponse(reply([topic('SESSION TAGS', 'c', 'session tags')]), m2, b3)!;
  assert.equal(m3.topics.length, 2);
  assert.equal(m3.topics[0].firstMessageId, 'a');
  assert.equal(m3.topics[0].id, m1.topics[0].id);
  const b4 = topicBatch([row('d', 'Discuss authentication and login')], m3, 4);
  const m4 = mergeTopicResponse(reply([topic('Authentication', 'd', 'authentication'), topic('Login', 'd', 'login')]), m3, b4)!;
  const merged = mergeTopicResponse(reply([], [], [{ from: m4.topics[2].id, into: m4.topics[3].id }]), m4, b4)!;
  assert.equal(merged.topics.length, 3);
  assert.equal(merged.topics[2].id, m4.topics[2].id);
});

test('bounded batches cover every character, including long-message suffixes and restart', () => {
  let memory = readTopicMemory();
  const content = 'x'.repeat(25000) + ' New independent topic at the end.';
  let read = '';
  for (let i = 0; i < 3; i++) {
    const batch = topicBatch([row('long', content)], memory, 1);
    read += batch.messages.map(m => m.text).join('');
    memory = readTopicMemory(JSON.stringify(mergeTopicResponse(reply([]), memory, batch)));
  }
  assert.equal(read, content);
  assert.equal(memory.cursor, 1);
  assert.equal(memory.charOffset, 0);
});

test('invalid replies do not advance coverage; invented and assistant-only evidence cannot create topics', () => {
  const memory = readTopicMemory();
  const batch = topicBatch([row('a', 'Build tags'), { ...row('b', 'Run tests'), role: 'assistant' }], memory, 2);
  assert.equal(mergeTopicResponse('broken', memory, batch), null);
  assert.equal(mergeTopicResponse('{"recap":"ok"}', memory, batch), null);
  const next = mergeTopicResponse(reply([topic('Invented', 'a', 'not present'), topic('Tests', 'b', 'Run tests')], ['bogus']), memory, batch)!;
  assert.equal(next, null, 'invalid evidence cannot skip uncovered history');
});
