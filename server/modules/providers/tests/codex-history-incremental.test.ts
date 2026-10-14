import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rename, rm, truncate, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { clearCodexRolloutCache, readCodexRollout } from '@/modules/providers/list/codex/codex-rollout-reader.provider.js';
import { CodexSessionsProvider } from '@/modules/providers/list/codex/codex-sessions.provider.js';
import type { NormalizedMessage } from '@/shared/index.js';

async function withIsolatedDatabase(runTest: () => Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-incremental-db-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
  try {
    await runTest();
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

const at = (second: number) => new Date(Date.UTC(2026, 9, 15, 0, 0, second)).toISOString();

/** A rollout exercising every stateful corner of the parser: turns, tools, exec/wait, sub-agents, compaction, rollback. */
function turn(index: number, second: number): object[] {
  const id = `turn-${index}`;
  return [
    { timestamp: at(second), type: 'event_msg', payload: { type: 'task_started', turn_id: id } },
    { timestamp: at(second), type: 'event_msg', payload: { type: 'user_message', turn_id: id, message: `Question ${index}` } },
    { timestamp: at(second + 1), type: 'response_item', payload: { type: 'reasoning', summary: [{ text: `Thinking ${index}` }] } },
    { timestamp: at(second + 1), type: 'response_item', payload: { type: 'function_call', name: 'shell_command', call_id: `call-${index}`, arguments: JSON.stringify({ command: `echo ${index}` }) } },
    { timestamp: at(second + 2), type: 'response_item', payload: { type: 'function_call_output', call_id: `call-${index}`, output: `out ${index}` } },
    { timestamp: at(second + 2), type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: `exec-${index}`, input: 'tools.exec_command({ command: "ls" })' } },
    { timestamp: at(second + 2), type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: `exec-${index}`, output: `Script running with cell ID cell-${index}\nOutput:\npart-a ` } },
    { timestamp: at(second + 3), type: 'response_item', payload: { type: 'function_call', name: 'wait', call_id: `wait-${index}`, arguments: JSON.stringify({ cell_id: `cell-${index}` }) } },
    { timestamp: at(second + 3), type: 'response_item', payload: { type: 'function_call_output', call_id: `wait-${index}`, output: 'part-b' } },
    { timestamp: at(second + 3), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 100 * index }, model_context_window: 1000 } } },
    // Out-of-order timestamp: the stable timestamp sort must still place it.
    { timestamp: at(second - 1), type: 'response_item', payload: { type: 'message', role: 'assistant', id: `answer-${index}`, content: [{ type: 'output_text', text: `Answer ${index}` }] } },
  ];
}

function rollout(turns: number, from = 0): object[] {
  const entries: object[] = [];
  for (let index = from; index < from + turns; index++) entries.push(...turn(index, 10 + index * 10));
  return entries;
}

const lines = (entries: object[]) => entries.map(entry => JSON.stringify(entry)).join('\n') + '\n';

/** Pages compared without the random ids generated for id-less entries. */
function comparable(messages: NormalizedMessage[]): unknown[] {
  return messages.map(({ id, ...rest }) => ({ ...rest, id: /_[0-9a-f]{8}-[0-9a-f]{4}-/.test(String(id)) ? '<generated>' : id }));
}

const PAGES: Array<[number | null, number]> = [[5, 0], [5, 5], [7, 3], [50, 0], [3, 40], [null, 0], [null, 4]];

async function pages(provider: CodexSessionsProvider, id: string) {
  const out = [];
  for (const [limit, offset] of PAGES) {
    const page = await provider.fetchHistory(id, { limit, offset });
    out.push({ ...page, messages: comparable(page.messages) });
  }
  return out;
}

/** The reference: what a cold full parse of the file returns now. */
async function fullParsePages(provider: CodexSessionsProvider, id: string) {
  clearCodexRolloutCache();
  return pages(provider, id);
}

test('incremental Codex history: cached pages, appends, partial lines, rollbacks, truncation and rotation match a full parse', { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-incremental-'));
  const transcript = path.join(root, 'rollout.jsonl');
  try {
    await withIsolatedDatabase(async () => {
      const provider = new CodexSessionsProvider();
      await writeFile(transcript, lines(rollout(4)));
      const id = sessionsDb.createSession('incremental', 'codex', root, 'Incremental', undefined, undefined, transcript);
      clearCodexRolloutCache();

      // Warm cache: every page equals the cold full parse, and repeated reads are stable.
      const warm = await pages(provider, id);
      assert.deepEqual(warm, await fullParsePages(provider, id));
      assert.deepEqual(await pages(provider, id), warm);
      assert.equal(warm[0].total, 4 * 5, 'user, thinking, Bash, exec and assistant per turn; results ride on their calls');

      // Append whole turns: picked up, identical to a full parse.
      await pages(provider, id);
      await appendFile(transcript, lines(rollout(2, 4)));
      const appended = await pages(provider, id);
      assert.ok(appended[3].messages.some(m => (m as { content?: string }).content === 'Question 5'));
      assert.deepEqual(appended, await fullParsePages(provider, id));

      // A half-written line is not shown and is picked up once completed.
      await pages(provider, id);
      const extra = JSON.stringify({ timestamp: at(500), type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'late', content: [{ type: 'output_text', text: 'Late answer' }] } });
      await appendFile(transcript, extra.slice(0, 40));
      const partial = await pages(provider, id);
      assert.deepEqual(partial, appended.map(page => ({ ...page })), 'an incomplete line changes nothing');
      await appendFile(transcript, extra.slice(40) + '\n');
      const completed = await pages(provider, id);
      assert.equal((completed[0].messages.at(-1) as { content?: string }).content, 'Late answer');
      assert.deepEqual(completed, await fullParsePages(provider, id));

      // A rollback appended later removes earlier turns from the cached state.
      await pages(provider, id);
      await appendFile(transcript, lines([{ timestamp: at(600), type: 'event_msg', payload: { type: 'thread_rolled_back', num_turns: 2 } }]));
      const rolledBack = await pages(provider, id);
      assert.ok(!rolledBack[5].messages.some(m => (m as { content?: string }).content === 'Question 5'));
      assert.deepEqual(rolledBack, await fullParsePages(provider, id));

      // Truncation: shorter file is re-read from scratch.
      await pages(provider, id);
      await writeFile(transcript, lines(rollout(2)));
      const truncated = await pages(provider, id);
      assert.equal(truncated[0].total, 2 * 5);
      assert.deepEqual(truncated, await fullParsePages(provider, id));

      // Rotation: a new file (new inode) renamed over the path, larger than before.
      await pages(provider, id);
      const replacement = path.join(root, 'replacement.jsonl');
      await writeFile(replacement, lines(rollout(5, 20)));
      await rename(replacement, transcript);
      const rotated = await pages(provider, id);
      assert.ok(rotated[5].messages.some(m => (m as { content?: string }).content === 'Question 24'));
      assert.ok(!rotated[5].messages.some(m => (m as { content?: string }).content === 'Question 0'));
      assert.deepEqual(rotated, await fullParsePages(provider, id));
    });
  } finally {
    clearCodexRolloutCache();
    await rm(root, { recursive: true, force: true });
  }
});

test('the rollout reader feeds only appended lines and re-reads rewritten files', { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-reader-'));
  const file = path.join(root, 'rollout.jsonl');
  let parsersCreated = 0;
  const factory = () => { parsersCreated++; const seen: string[] = []; return { seen, consume: (line: string) => { seen.push(line); return true; } }; };
  try {
    clearCodexRolloutCache();
    await writeFile(file, '{"n":1}\n{"n":2}\n');
    const first = await readCodexRollout(file, factory);
    assert.deepEqual(first.parser.seen, ['{"n":1}', '{"n":2}']);

    const unchanged = await readCodexRollout(file, factory);
    assert.equal(unchanged.parser, first.parser);
    assert.equal(unchanged.generation, first.generation, 'no new bytes, same generation');

    await appendFile(file, '{"n":3}\n');
    const grown = await readCodexRollout(file, factory);
    assert.equal(grown.parser, first.parser, 'the same parser continues');
    assert.deepEqual(grown.parser.seen, ['{"n":1}', '{"n":2}', '{"n":3}'], 'old lines are not fed twice');
    assert.notEqual(grown.generation, first.generation);
    assert.equal(parsersCreated, 1);

    // A complete record still missing its newline is read; if that line then
    // grows, a full read would join the bytes, so the reader starts over.
    await appendFile(file, '{"n":4}');
    assert.deepEqual((await readCodexRollout(file, factory)).parser.seen.at(-1), '{"n":4}');
    await appendFile(file, '5}\n');
    const rejoined = await readCodexRollout(file, factory);
    assert.equal(parsersCreated, 2);
    assert.deepEqual(rejoined.parser.seen, ['{"n":1}', '{"n":2}', '{"n":3}', '{"n":4}5}']);

    // Same length, different content, newer mtime: re-read.
    await writeFile(file, '{"m":1}\n');
    await readCodexRollout(file, factory);
    const created = parsersCreated;
    await writeFile(file, '{"m":2}\n');
    const future = new Date(Date.now() + 5000);
    await utimes(file, future, future);
    assert.deepEqual((await readCodexRollout(file, factory)).parser.seen, ['{"m":2}']);
    assert.equal(parsersCreated, created + 1);

    // Rewritten head that also grew: the head fingerprint catches it.
    await writeFile(file, '{"x":1}\n{"x":2}\n');
    await readCodexRollout(file, factory);
    await writeFile(file, '{"y":1}\n{"x":2}\n{"x":3}\n');
    assert.deepEqual((await readCodexRollout(file, factory)).parser.seen, ['{"y":1}', '{"x":2}', '{"x":3}']);

    // Truncated to nothing.
    await truncate(file, 0);
    assert.deepEqual((await readCodexRollout(file, factory)).parser.seen, []);

    // Concurrent readers of one file share consistent state.
    await writeFile(file, Array.from({ length: 500 }, (_, n) => JSON.stringify({ n })).join('\n') + '\n');
    const results = await Promise.all([readCodexRollout(file, factory), readCodexRollout(file, factory), readCodexRollout(file, factory)]);
    assert.ok(results.every(result => result.parser === results[0].parser));
    assert.equal(results[0].parser.seen.length, 500);
  } finally {
    clearCodexRolloutCache();
    await rm(root, { recursive: true, force: true });
  }
});
