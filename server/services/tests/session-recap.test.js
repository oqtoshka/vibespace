import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { __testing } from '../session-recap.service.js';

const { readTranscriptTail, parseRecapResponse, buildRecapPrompt } = __testing;

const jsonl = (entries) => entries.map((entry) => JSON.stringify(entry)).join('\n');

async function writeTranscript(lines) {
  const dir = await mkdtemp(path.join(tmpdir(), 'recap-'));
  const file = path.join(dir, 'session.jsonl');
  await writeFile(file, lines, 'utf8');
  return file;
}

test('readTranscriptTail keeps user and assistant prose', async () => {
  const file = await writeTranscript(jsonl([
    { type: 'user', message: { content: [{ type: 'text', text: 'fix the prune job' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Found two bugs.' }] } },
  ]));

  assert.deepEqual(await readTranscriptTail(file), [
    { role: 'user', text: 'fix the prune job' },
    { role: 'assistant', text: 'Found two bugs.' },
  ]);
});

test('readTranscriptTail drops tool traffic, which is most of the bytes', async () => {
  const file = await writeTranscript(jsonl([
    { type: 'user', message: { content: [{ type: 'text', text: 'run the tests' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: '259 passing' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'All 259 pass.' }] } },
  ]));

  assert.deepEqual(await readTranscriptTail(file), [
    { role: 'user', text: 'run the tests' },
    { role: 'assistant', text: 'All 259 pass.' },
  ]);
});

test('readTranscriptTail skips host chatter that is not conversation', async () => {
  const file = await writeTranscript(jsonl([
    { type: 'user', message: { content: [{ type: 'text', text: '<local-command-name>/compact</local-command-name>' }] } },
    { type: 'user', message: { content: [{ type: 'text', text: '<system-reminder>be careful</system-reminder>' }] } },
    { type: 'user', message: { content: [{ type: 'text', text: 'actual question' }] } },
  ]));

  assert.deepEqual(await readTranscriptTail(file), [{ role: 'user', text: 'actual question' }]);
});

test('readTranscriptTail truncates a pasted wall of text', async () => {
  const file = await writeTranscript(jsonl([
    { type: 'user', message: { content: [{ type: 'text', text: 'x'.repeat(5000) }] } },
  ]));

  const [message] = await readTranscriptTail(file);
  assert.equal(message.text.length, 601, 'capped at 600 chars plus the ellipsis');
  assert.ok(message.text.endsWith('…'));
});

test('readTranscriptTail keeps only the tail of a long session', async () => {
  const entries = Array.from({ length: 100 }, (_, index) => ({
    type: 'user',
    message: { content: [{ type: 'text', text: `message ${index}` }] },
  }));
  const file = await writeTranscript(jsonl(entries));

  const messages = await readTranscriptTail(file);
  assert.equal(messages.length, 40);
  assert.equal(messages.at(-1).text, 'message 99', 'the newest exchange must survive');
});

test('readTranscriptTail survives a missing file and a corrupt line', async () => {
  assert.deepEqual(await readTranscriptTail('/nope/missing.jsonl'), []);

  const file = await writeTranscript([
    '{ not json',
    JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'still read' }] } }),
  ].join('\n'));
  assert.deepEqual(await readTranscriptTail(file), [{ role: 'user', text: 'still read' }]);
});

test('parseRecapResponse reads a bare object', () => {
  assert.deepEqual(
    parseRecapResponse('{"title": "Dind Image Pruning", "recap": "Fixed the cron."}'),
    { title: 'Dind Image Pruning', recap: 'Fixed the cron.' },
  );
});

test('parseRecapResponse digs the object out of a fence or preamble', () => {
  const fenced = '```json\n{"title": "A B", "recap": "C."}\n```';
  assert.deepEqual(parseRecapResponse(fenced), { title: 'A B', recap: 'C.' });

  const chatty = 'Sure! Here you go:\n{"title": "A B", "recap": "C."}\nHope that helps.';
  assert.deepEqual(parseRecapResponse(chatty), { title: 'A B', recap: 'C.' });
});

test('parseRecapResponse caps oversized fields rather than rejecting them', () => {
  const result = parseRecapResponse(JSON.stringify({ title: 'T'.repeat(200), recap: 'R'.repeat(900) }));
  assert.equal(result.title.length, 60);
  assert.equal(result.recap.length, 400);
});

test('parseRecapResponse rejects what it cannot use', () => {
  assert.equal(parseRecapResponse(''), null);
  assert.equal(parseRecapResponse('no json here'), null);
  assert.equal(parseRecapResponse('{"title": "", "recap": ""}'), null);
  assert.equal(parseRecapResponse('{broken'), null);
});

test('buildRecapPrompt labels roles and includes the transcript', () => {
  const prompt = buildRecapPrompt([
    { role: 'user', text: 'fix the prune' },
    { role: 'assistant', text: 'done' },
  ]);

  assert.match(prompt, /User: fix the prune/);
  assert.match(prompt, /Assistant: done/);
  assert.match(prompt, /"title"/);
  assert.match(prompt, /"recap"/);
});
