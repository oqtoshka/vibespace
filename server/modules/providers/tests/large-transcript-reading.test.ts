import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { findLastJsonlEntry } from '@/shared/utils.js';

import { readCodexRollout } from '../list/codex/codex-rollout-reader.provider.js';
import { scanClaudeTranscript } from '../services/claude-transcript-scan.service.js';

const user = (uuid: string, text: string) => `${JSON.stringify({ type: 'user', uuid, message: { content: text } })}\n`;
const assistant = (text: string) => `${JSON.stringify({
  type: 'assistant', message: { content: [{ type: 'text', text }, { type: 'tool_use', name: 'Bash' }] },
})}\n`;
const progress = `${JSON.stringify({ type: 'progress', data: 'x'.repeat(200) })}\n`;

async function withDirectory(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'large-transcript-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('the scan bounds its tail, counts every row, and resumes from the cursor', async () => {
  await withDirectory(async (directory) => {
    const file = path.join(directory, 'long.jsonl');
    let body = '';
    for (let i = 0; i < 3000; i += 1) body += user(`u-${i}`, `ask ${i}`) + progress + assistant(`done ${i}`);
    await writeFile(file, body);

    const first = await scanClaudeTranscript(file, { cursor: 4001, maxUserChars: 40 });
    assert.equal(first.state.historyTotal, 6000);
    assert.equal(first.state.total, 6000);
    assert.equal(first.state.tail.at(-1)?.text, 'done 2999');
    assert.ok(first.state.tail.length <= 120);
    // Row 4001 is the assistant of pair 2000, and the batch then starts at ask 2001.
    assert.deepEqual(first.rows[0], { type: 'assistant' });
    const asks = first.rows.filter(row => row.type === 'user') as Array<{ uuid: string }>;
    assert.equal(asks[0].uuid, 'u-2001');
    assert.ok(first.rows.length < 40, 'the rows stop at the requested budget');
  });
});

test('the scan parses only appended lines and restarts when the file is rewritten', async () => {
  await withDirectory(async (directory) => {
    const file = path.join(directory, 'grow.jsonl');
    await writeFile(file, user('a', 'one') + assistant('two'));
    const first = await scanClaudeTranscript(file, { cursor: null, maxUserChars: 10 });
    assert.equal(first.state.total, 2);

    // A half-written record waits for its newline instead of being lost or misread.
    const partial = user('b', 'three');
    await appendFile(file, partial.slice(0, 12));
    assert.equal((await scanClaudeTranscript(file, { cursor: null, maxUserChars: 10 })).state.total, 2);
    await appendFile(file, partial.slice(12));
    const grown = await scanClaudeTranscript(file, { cursor: null, maxUserChars: 10 });
    assert.equal(grown.state.total, 3);
    assert.equal(grown.state.tail.at(-1)?.text, 'three');

    await truncate(file, 0);
    await writeFile(file, user('r', 'rewritten'));
    const rewritten = await scanClaudeTranscript(file, { cursor: null, maxUserChars: 10 });
    assert.deepEqual(rewritten.state.tail, [{ role: 'user', text: 'rewritten' }]);
    assert.equal(rewritten.state.total, 1);
  });
});

test('findLastJsonlEntry returns the latest match across read chunks', async () => {
  await withDirectory(async (directory) => {
    const file = path.join(directory, 'tail.jsonl');
    const filler = `${JSON.stringify({ type: 'tool', data: 'y'.repeat(300_000) })}\n`;
    await writeFile(file, `${JSON.stringify({ usage: 1 })}\n${JSON.stringify({ usage: 2 })}\n${filler.repeat(12)}not json\n{"usage":`);
    const pick = (entry: Record<string, unknown>) => (typeof entry.usage === 'number' ? entry.usage : null);
    assert.equal(await findLastJsonlEntry(file, pick), 2);
    assert.equal(await findLastJsonlEntry(file, pick, { contains: '"usage"' }), 2);
    assert.equal(await findLastJsonlEntry(file, () => null), null);
    await assert.rejects(findLastJsonlEntry(path.join(directory, 'gone.jsonl'), pick), { code: 'ENOENT' });
  });
});

test('a rollout past the window is parsed from a line boundary near its end', { concurrency: false }, async () => {
  const previous = process.env.VS_CODEX_ROLLOUT_WINDOW_BYTES;
  process.env.VS_CODEX_ROLLOUT_WINDOW_BYTES = '1000';
  try {
    await withDirectory(async (directory) => {
      const file = path.join(directory, 'rollout.jsonl');
      const lineOf = (i: number) => `${JSON.stringify({ i, pad: 'z'.repeat(80) })}\n`;
      await writeFile(file, Array.from({ length: 200 }, (_, i) => lineOf(i)).join(''));
      const seen: number[] = [];
      const parser = () => ({ consume(line: string) { seen.push((JSON.parse(line) as { i: number }).i); return true; } });
      await readCodexRollout(file, parser);
      assert.ok(seen.length > 0 && seen.length <= 12, `parsed ${seen.length} lines`);
      assert.equal(seen.at(-1), 199);
      assert.deepEqual(seen, seen.map((_, index) => seen[0] + index), 'whole, consecutive lines');

      // Appends inside the window stay incremental.
      await appendFile(file, lineOf(200));
      seen.length = 0;
      await readCodexRollout(file, parser);
      assert.deepEqual(seen, [200]);
    });
  } finally {
    if (previous === undefined) delete process.env.VS_CODEX_ROLLOUT_WINDOW_BYTES;
    else process.env.VS_CODEX_ROLLOUT_WINDOW_BYTES = previous;
  }
});
