import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { __testing } from '../session-recap.service.js';

const { readTranscriptTail, readIndexedTranscriptTail, parseRecapResponse, buildRecapPrompt } = __testing;

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

  assert.deepEqual(await readTranscriptTail(file), {
    messages: [
      { role: 'user', text: 'fix the prune job' },
      { role: 'assistant', text: 'Found two bugs.' },
    ],
    total: 2,
  });
});

test('readTranscriptTail drops tool traffic, which is most of the bytes', async () => {
  const file = await writeTranscript(jsonl([
    { type: 'user', message: { content: [{ type: 'text', text: 'run the tests' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: '259 passing' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'All 259 pass.' }] } },
  ]));

  assert.deepEqual(await readTranscriptTail(file), {
    messages: [
      { role: 'user', text: 'run the tests' },
      { role: 'assistant', text: 'All 259 pass.' },
    ],
    total: 2,
  });
});

test('readTranscriptTail skips host chatter that is not conversation', async () => {
  const file = await writeTranscript(jsonl([
    { type: 'user', message: { content: [{ type: 'text', text: '<local-command-name>/compact</local-command-name>' }] } },
    { type: 'user', message: { content: [{ type: 'text', text: '<system-reminder>be careful</system-reminder>' }] } },
    { type: 'user', message: { content: [{ type: 'text', text: 'actual question' }] } },
  ]));

  assert.deepEqual(await readTranscriptTail(file), {
    messages: [{ role: 'user', text: 'actual question' }],
    total: 1,
  });
});

test('readTranscriptTail truncates a pasted wall of text', async () => {
  const file = await writeTranscript(jsonl([
    { type: 'user', message: { content: [{ type: 'text', text: 'x'.repeat(5000) }] } },
  ]));

  const [message] = (await readTranscriptTail(file)).messages;
  assert.equal(message.text.length, 601, 'capped at 600 chars plus the ellipsis');
  assert.ok(message.text.endsWith('…'));
});

test('readTranscriptTail keeps only the tail of a long session', async () => {
  const entries = Array.from({ length: 100 }, (_, index) => ({
    type: 'user',
    message: { content: [{ type: 'text', text: `message ${index}` }] },
  }));
  const file = await writeTranscript(jsonl(entries));

  const { messages, total } = await readTranscriptTail(file);
  assert.equal(messages.length, 40);
  assert.equal(messages.at(-1).text, 'message 99', 'the newest exchange must survive');
  // The count is the whole session, not the tail: a recap that compared tail
  // lengths would freeze at 40 and never refresh again.
  assert.equal(total, 100);
});

test('readTranscriptTail survives a missing file and a corrupt line', async () => {
  assert.deepEqual(await readTranscriptTail('/nope/missing.jsonl'), { messages: [], total: 0 });

  const file = await writeTranscript([
    '{ not json',
    JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'still read' }] } }),
  ].join('\n'));
  assert.deepEqual(await readTranscriptTail(file), {
    messages: [{ role: 'user', text: 'still read' }],
    total: 1,
  });
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

// OpenCode keeps every conversation in one shared SQLite store rather than a
// file per session, so the recap for one is built from the indexed history the
// UI renders instead of a transcript on disk.
test('readIndexedTranscriptTail keeps the prose and drops the plumbing', async () => {
  const history = {
    total: 6,
    messages: [
      { kind: 'text', role: 'user', content: 'fix the prune job' },
      { kind: 'tool_use', role: 'assistant', toolName: 'bash', content: 'docker prune' },
      { kind: 'tool_result', role: 'user', content: 'reclaimed 4GB' },
      { kind: 'thinking', role: 'assistant', content: 'the cron is wrong' },
      { kind: 'text', role: 'assistant', content: 'Found two bugs.' },
      { kind: 'text', role: 'user', content: '   ' },
    ],
  };

  assert.deepEqual(await readIndexedTranscriptTail('app-1', async () => history), {
    messages: [
      { role: 'user', text: 'fix the prune job' },
      { role: 'assistant', text: 'Found two bugs.' },
    ],
    total: 6,
  });
});

test('readIndexedTranscriptTail applies the same caps as the file reader', async () => {
  const messages = Array.from({ length: 100 }, (_, index) => ({
    kind: 'text',
    role: 'user',
    content: `message ${index}`,
  }));
  messages.push({ kind: 'text', role: 'assistant', content: 'x'.repeat(5000) });

  const { messages: tail, total } = await readIndexedTranscriptTail(
    'app-1',
    async () => ({ total: messages.length, messages }),
  );

  assert.equal(tail.length, 40);
  assert.equal(tail.at(-1).text.length, 601, 'capped at 600 chars plus the ellipsis');
  assert.equal(total, 101, 'the count is the whole session, so the recap keeps refreshing');
});

test('readIndexedTranscriptTail skips host chatter and survives a failed read', async () => {
  const chatter = {
    total: 2,
    messages: [
      { kind: 'text', role: 'user', content: '<local-command-name>/compact</local-command-name>' },
      { kind: 'text', role: 'user', content: 'actual question' },
    ],
  };
  assert.deepEqual(await readIndexedTranscriptTail('app-1', async () => chatter), {
    messages: [{ role: 'user', text: 'actual question' }],
    total: 2,
  });

  assert.deepEqual(
    await readIndexedTranscriptTail('app-1', async () => {
      throw new Error('session not found');
    }),
    { messages: [], total: 0 },
  );
});
