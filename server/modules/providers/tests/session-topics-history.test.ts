import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { __testing } from '../services/session-recap.service.js';

test('historical pages retain beginning and middle; restart resumes committed coverage; privacy races discard replies', async () => {
  const previous = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(tmpdir(), 'session-topics-history-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
  try {
    sessionsDb.createAppSession('history', 'codex', directory, 'History');
    sessionsDb.assignProviderSessionId('history', 'provider-history');
    const rows = Array.from({ length: 190 }, (_, i) => ({ id: `m-${i}`, kind: 'text', role: 'user', content: `Subject ${i}` }));
    const offsets: number[] = [];
    let calls = 0;
    const input = {
      sessionId: 'history', cwd: directory, useIndexedHistory: true,
      fetchHistory: async (_id: string, options: { limit: number; offset: number }) => {
        offsets.push(options.offset);
        const end = rows.length - options.offset;
        return { messages: rows.slice(Math.max(0, end - options.limit), end), total: Math.floor(rows.length / 2) };
      },
      runQuery: async (prompt: string, _options: unknown, writer: { send: (data: unknown) => void }) => {
        calls++;
        const batch = JSON.parse(prompt.split('NEW CONVERSATION (chronological): ')[1]);
        writer.send({ kind: 'text', content: JSON.stringify({ title: 'Topics', recap: 'Current work', kinds: ['research'],
          topics: batch.filter((m: { id: string }) => ['m-0', 'm-85', 'm-180'].includes(m.id)).map((m: { id: string; text: string }) =>
            ({ label: m.text, summary: m.text, messageId: m.id, quote: m.text })) }) });
      },
    };
    assert.equal(await __testing.generateRecap(input), true);
    assert.equal(JSON.parse(sessionsDb.getSessionById('history')!.topic_memory!).cursor, 80);
    assert.equal(await __testing.generateRecap(input), true);
    assert.equal(await __testing.generateRecap(input), false);
    const memory = JSON.parse(sessionsDb.getSessionById('history')!.topic_memory!);
    assert.deepEqual(memory.topics.map((t: { label: string }) => t.label), ['Subject 0', 'Subject 85', 'Subject 180']);
    assert.equal(memory.origin, 'Subject 0');
    await __testing.generateRecap(input);
    assert.equal(calls, 3, 'already-covered history incurs no model call');
    assert.ok(offsets.every(offset => offset === 0), 'UI totals cannot be used as pagination offsets');
    assert.equal(sessionsDb.updateSessionTopicMemory('history', null, '{}'), false, 'CAS rejects a stale writer');
    rows.push({ id: 'late', role: 'user', kind: 'text', content: 'New subject' });
    await __testing.generateRecap({ ...input, runQuery: async (_prompt, _options, writer) => {
      sessionsDb.deleteSessionById('history');
      writer.send({ kind: 'text', content: JSON.stringify({ title: 'Resurrected', recap: 'Leak', topics: [], kinds: [] }) });
    } });
    assert.equal(sessionsDb.getSessionById('history'), null);
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
