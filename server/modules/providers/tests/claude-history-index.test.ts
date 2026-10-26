import assert from 'node:assert/strict';
import fs from 'node:fs';
import { appendFile, mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { sessionsDb } from '@/modules/database/index.js';
import type { FetchHistoryOptions } from '@/shared/index.js';

import { ClaudeHistoryIndex } from '../list/claude/claude-history-index.js';
import { ClaudeSessionsProvider } from '../list/claude/claude-sessions.provider.js';
import { syntheticSessionId, syntheticTurn } from '../../../../scripts/generate-claude-history.mjs';

import { referenceClaudeHistory } from './claude-history-reference.js';

const session = syntheticSessionId;
const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const provider = new ClaudeSessionsProvider();
const normalize = provider.normalizeMessage.bind(provider);

async function fixture(run: (directory: string, file: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'claude-history-test-'));
  const file = path.join(directory, `${session}.jsonl`);
  const original = sessionsDb.getSessionById;
  sessionsDb.getSessionById = (() => ({ jsonl_path: file })) as unknown as typeof original;
  try { await run(directory, file); }
  finally { sessionsDb.getSessionById = original; await rm(directory, { recursive: true, force: true }); }
}

let comparisons = 0;
after(() => console.log(JSON.stringify({ differentialPageComparisons: comparisons })));
async function compare(file: string, index?: ClaudeHistoryIndex, limits: readonly (number | null)[] = [null, 0, 1, 2, 5, 17, 100], offsets: readonly number[] = [0, 1, 3, 19, 1000]) {
  for (const limit of limits) {
    for (const offset of offsets) {
      const options: FetchHistoryOptions = { limit, offset };
      const expected = await referenceClaudeHistory(session, options);
      const actual = index
        ? await index.read(file, session, session, options, normalize)
        : await provider.fetchHistory(session, options);
      assert.deepEqual(actual, expected, `page ${JSON.stringify(options)} comparison ${comparisons++}`);
    }
  }
}

test('Claude history pages equal the original reader across appends, partial lines, malformed rows and rotation', { timeout: 180_000 }, async () => {
  await fixture(async (_directory, file) => {
    await writeFile(file, jsonl(Array.from({ length: 12 }, (_, i) => syntheticTurn(i, 100)).flat()));
    await compare(file);
    await compare(file); // unchanged signature
    let random = 12345;
    for (let i = 12; i < 18; i++) {
      random = (random * 1664525 + 1013904223) >>> 0;
      const rows = syntheticTurn(i, random % 200);
      // Timestamps can arrive out of order; ids/tool results still use sorted order.
      if (i % 2) rows[0].timestamp = '2025-12-01T00:00:00.000Z';
      const data = jsonl(rows);
      const split = Math.floor(data.length * 0.6);
      await appendFile(file, data.slice(0, split));
      await compare(file);
      await appendFile(file, data.slice(split));
      await compare(file);
    }
    await appendFile(file, 'malformed\nnull\n' + JSON.stringify({ ...syntheticTurn(20, 30)[0], uuid: 'valid-tail' }));
    await compare(file);
    await appendFile(file, '\n');
    await compare(file);
    await writeFile(file, jsonl(syntheticTurn(2, 40))); // same inode, shrink
    await compare(file);
    await rename(file, `${file}.old`);
    await writeFile(file, jsonl(syntheticTurn(1, 30))); // new inode
    await compare(file);
    await writeFile(file, jsonl(syntheticTurn(3, 4000))); // truncate and regrow past the previous size
    await compare(file);
    await rm(file);
    await compare(file); // transcriptMissing, including non-default pages
  });
});

test('Claude history preserves fractional, negative and non-finite pagination inputs', async () => {
  await fixture(async (_directory, file) => {
    await writeFile(file, jsonl(syntheticTurn(1, 20)));
    await compare(file, undefined, [null, -3, 0.5, NaN, Infinity], [-4, 0, 2.5, NaN, Infinity]);
  });
});

test('Claude history preserves sorting, retry dedupe, result overwrite, internal rows and legacy invalid dates', async () => {
  await fixture(async (_directory, file) => {
    const rows = [syntheticTurn(47, 200), syntheticTurn(0, 50), syntheticTurn(94, 30)].flat();
    rows.push({ ...syntheticTurn(47, 12)[2], uuid: 'new-result', timestamp: '2026-03-01T00:00:00.000Z', interruptedByShutdown: true } as typeof rows[number]);
    rows.push({ ...syntheticTurn(4, 12)[0], uuid: 'invalid-date', timestamp: 'invalid' });
    await writeFile(file, jsonl(rows));
    await compare(file);
    await appendFile(file, jsonl(syntheticTurn(3, 20)));
    await compare(file);
  });
});

test('Claude history notices subagent files appearing, growing, being replaced and disappearing', async () => {
  await fixture(async (directory, file) => {
    await writeFile(file, jsonl(syntheticTurn(0, 60)));
    await compare(file);
    const agentDirectory = path.join(directory, session, 'subagents');
    await mkdir(agentDirectory, { recursive: true });
    const agentFile = path.join(agentDirectory, 'agent-example-agent.jsonl');
    await writeFile(agentFile, jsonl(syntheticTurn(7, 100)));
    await compare(file);
    await appendFile(agentFile, jsonl(syntheticTurn(8, 200)));
    await compare(file);
    await rename(agentFile, `${agentFile}.old`);
    await writeFile(agentFile, jsonl(syntheticTurn(9, 50)));
    await compare(file);
    await rm(agentFile);
    await compare(file);
  });
});

test('Claude history has bounded LRU retention, shares concurrent work and isolates returned messages', async () => {
  await fixture(async (directory, file) => {
    const index = new ClaudeHistoryIndex({ maxBytes: 256 * 1024, maxIndexes: 2 });
    try {
      await writeFile(file, jsonl(syntheticTurn(0, 200)));
      const agentDirectory = path.join(directory, session, 'subagents');
      await mkdir(agentDirectory, { recursive: true });
      await writeFile(path.join(agentDirectory, 'agent-example-agent.jsonl'), jsonl(syntheticTurn(1, 400_000)));
      let normalizations = 0;
      const countNormalize = (...args: Parameters<typeof normalize>) => { normalizations++; return normalize(...args); };
      const read = () => index.read(file, session, session, { limit: 3 }, countNormalize);
      const concurrent = await Promise.all([read(), read(), read()]);
      assert.deepEqual(concurrent[0], concurrent[1]);
      assert.deepEqual(concurrent[1], concurrent[2]);
      assert.ok(normalizations < 15, 'one refresh/page shared across all three callers');
      concurrent[0].messages[0].content = 'mutated';
      assert.notEqual(concurrent[1].messages[0].content, 'mutated');
      const first = read();
      const mutateFirst = first.then(result => { result.messages[0].content = 'mutated before follower settles'; });
      const follower = read();
      await mutateFirst;
      assert.notEqual((await follower).messages[0].content, 'mutated before follower settles');
      assert.ok(index.stats.estimatedBytes <= index.stats.maxBytes);
      console.log(JSON.stringify({ cacheBudget: index.stats }));
      assert.equal(index.stats.payloads, 0, 'oversized subagent payload is returned but never retained');
      for (let i = 0; i < 5; i++) {
        const another = path.join(directory, `another-${i}.jsonl`);
        await writeFile(another, jsonl(syntheticTurn(i + 1, 20)));
        await index.read(another, session, session, { limit: 1 }, normalize);
      }
      assert.equal(index.stats.indexes, 2);
      assert.ok(index.stats.estimatedBytes <= index.stats.maxBytes);
      await compare(file, index); // evicted index rebuilds identically
    } finally { index.close(); }
  });
});

test('Claude history keeps provider-native and application session identities separate', async () => {
  await fixture(async (_directory, file) => {
    await writeFile(file, jsonl(syntheticTurn(0, 40)));
    const appSession = '22222222-2222-4222-8222-222222222222';
    const options = { limit: 3, providerSessionId: session };
    assert.deepEqual(await provider.fetchHistory(appSession, options), await referenceClaudeHistory(appSession, options));
  });
});

test('Claude history lets an unrelated warm page finish during a cold scan and bounds concurrent index residency', async () => {
  await fixture(async (directory, file) => {
    const index = new ClaudeHistoryIndex({ maxBytes: 1024 * 1024, maxIndexes: 2 });
    try {
      await writeFile(file, jsonl(syntheticTurn(1, 20)));
      await index.read(file, session, session, { limit: 1 }, normalize);
      const coldFile = path.join(directory, 'cold.jsonl');
      await writeFile(coldFile, jsonl(Array.from({ length: 200 }, (_, i) => syntheticTurn(i, 16_384)).flat()));
      const cold = index.read(coldFile, session, session, { limit: 1 }, normalize);
      await new Promise(resolve => setImmediate(resolve));
      const warm = index.read(file, session, session, { limit: 1 }, normalize);
      assert.equal(await Promise.race([cold.then(() => 'cold'), warm.then(() => 'warm')]), 'warm');
      await Promise.all([cold, warm]);
      const files = await Promise.all(Array.from({ length: 5 }, async (_, i) => {
        const another = path.join(directory, `concurrent-${i}.jsonl`);
        await writeFile(another, jsonl(syntheticTurn(i + 1, 20)));
        return another;
      }));
      await Promise.all(files.map(another => index.read(another, session, session, { limit: 1 }, normalize)));
      assert.ok(index.stats.estimatedBytes <= index.stats.maxBytes);
      assert.equal(index.stats.indexes, 2);
    } finally { index.close(); }
  });
});

test('Claude history retries an unavailable subagent without treating a failed read as a cached empty result', async () => {
  await fixture(async (directory, file) => {
    const index = new ClaudeHistoryIndex();
    const original = fs.createReadStream;
    try {
      await writeFile(file, jsonl(syntheticTurn(0, 20)));
      const agentDirectory = path.join(directory, session, 'subagents');
      await mkdir(agentDirectory, { recursive: true });
      const agentFile = path.join(agentDirectory, 'agent-example-agent.jsonl');
      await writeFile(agentFile, jsonl(syntheticTurn(1, 20)));
      fs.createReadStream = ((target, options) => original(target === agentFile ? `${agentFile}.unavailable` : target, options)) as typeof original;
      const first = await index.read(file, session, session, { limit: null }, normalize);
      assert.equal(first.messages.find(message => message.kind === 'tool_use')?.subagentTools, undefined);
      assert.equal(index.stats.payloads, 0);
      fs.createReadStream = original;
      assert.deepEqual(await index.read(file, session, session, { limit: null }, normalize), await referenceClaudeHistory(session, { limit: null }));
      assert.equal(index.stats.payloads, 1);
    } finally { fs.createReadStream = original; index.close(); }
  });
});

test('Claude history matches mixed content fixtures and CRLF-delimited Unicode rows', async () => {
  await fixture(async (_directory, file) => {
    const base = { sessionId: session, timestamp: '2026-01-01T00:00:00.000Z' };
    const rows = [
      ...syntheticTurn(0, 30),
      { ...base, uuid: 'image-result', type: 'user', toolUseResult: { status: 'done' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-0', content: [{ type: 'text', text: 'result' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' } }] }] } },
      { ...base, uuid: 'meta', isMeta: true, type: 'user', message: { role: 'user', content: 'hidden metadata' } },
      { ...base, uuid: 'local', type: 'user', message: { role: 'user', content: '<command-name>/example</command-name><command-args>你好</command-args>' } },
      { ...base, uuid: 'stdout', type: 'user', message: { role: 'user', content: '<local-command-stdout>example output</local-command-stdout>' } },
      { ...base, uuid: 'compact', type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto', preTokens: 1200 } },
      { ...base, uuid: 'queued', type: 'attachment', attachment: { type: 'queued_command', source_uuid: 'queued-source', prompt: 'Queued example 🐈' } },
      { ...base, uuid: 'error', type: 'assistant', isApiErrorMessage: true, message: { role: 'assistant', content: [{ type: 'text', text: 'Prompt is too long' }] } },
      { ...base, uuid: 'refusal', type: 'system', subtype: 'model_refusal_no_fallback', originalModel: 'example-model' },
      { ...base, uuid: 'sidechain', type: 'user', message: { isSidechain: true, role: 'user', content: 'hidden sidechain' } },
      { ...base, uuid: 'top-tool', type: 'tool_use', toolName: 'Example', toolCallId: 'top-tool-id' },
      { ...base, uuid: 'top-result', type: 'tool_result', toolCallId: 'top-tool-id', output: 'done' },
    ];
    await writeFile(file, rows.map(row => JSON.stringify(row)).join('\r\n') + '\r');
    await compare(file);
    await appendFile(file, '\n' + jsonl(syntheticTurn(1, 20)));
    await compare(file);
  });
});
