import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { registerSessionTopicAuthoritySource } from '@/shared/index.js';

import { __testing } from '../services/session-recap.service.js';

test('external card authority preserves title/recap, historical memory, and bounded tail reads', async () => {
  const previous = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(tmpdir(), 'topic-authority-recap-'));
  closeConnection(); process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
  let canonical = true;
  let deleteOnRead = false;
  const remove = registerSessionTopicAuthoritySource(context => {
    assert.equal(context.providerSessionId, 'native');
    if (deleteOnRead) sessionsDb.deleteSessionById('app');
    return canonical ? 'primary-agent' : null;
  });
  try {
    sessionsDb.createAppSession('app', 'codex', directory, 'History');
    sessionsDb.assignProviderSessionId('app', 'native');
    const historical = JSON.stringify({ version: 1, topics: [{ id: 'old', label: 'Historic topic' }], kinds: [],
      origin: 'Original goal', cursor: 0, charOffset: 0, source: 'indexed', updatedAt: '' });
    assert.equal(sessionsDb.updateSessionTopicMemory('app', null, historical), true);
    const limits: number[] = [];
    const rows = [{ id: 'u', role: 'user', kind: 'text', content: 'Current goal' },
      { id: 'a', role: 'assistant', kind: 'text', content: 'Current result' }];
    let calls = 0;
    const input = { sessionId: 'app', cwd: directory, useIndexedHistory: true,
      fetchHistory: async (_id: string, options: { limit: number; offset: number }) => {
        limits.push(options.limit); return { messages: rows, total: rows.length };
      },
      runQuery: async (prompt: string, _options: unknown, writer: { send: (data: unknown) => void }) => {
        calls++; assert.doesNotMatch(prompt, /SAVED TOPICS|NEW CONVERSATION/);
        writer.send({ kind: 'text', content: JSON.stringify({ title: 'Current session', recap: 'Current progress',
          topics: [{ malformed: true }] }) });
      },
    };
    assert.equal(await __testing.generateRecap(input), false);
    assert.deepEqual(limits, [160]);
    assert.equal(sessionsDb.getSessionById('app')!.topic_memory, historical);
    assert.equal(sessionsDb.getSessionById('app')!.recap, 'Current progress');
    await __testing.generateRecap(input);
    assert.equal(calls, 1, 'external authority does not repeatedly consume historic topic coverage');

    // A helper admitted before a canonical claim cannot publish its stale topics afterwards.
    canonical = false;
    rows.push({ id: 'late', role: 'user', kind: 'text', content: 'Next goal' });
    await __testing.generateRecap({ ...input, runQuery: async (prompt, _options, writer) => {
      assert.match(prompt, /SAVED TOPICS/); canonical = true;
      writer.send({ kind: 'text', content: JSON.stringify({ title: null, recap: 'Later progress', kinds: [],
        topics: [{ label: 'Stale automatic topic', summary: 'Old claim', messageId: 'u1', quote: 'Current goal' }] }) });
    } });
    assert.equal(sessionsDb.getSessionById('app')!.topic_memory, historical);
    assert.equal(sessionsDb.getSessionById('app')!.recap, 'Later progress');

    canonical = false;
    rows.push({ id: 'last', role: 'user', kind: 'text', content: 'Final goal' });
    await __testing.generateRecap({ ...input, runQuery: async (_prompt, _options, writer) => {
      deleteOnRead = true;
      writer.send({ kind: 'text', content: JSON.stringify({ title: 'Resurrected', recap: 'Leak', kinds: [], topics: [] }) });
    } });
    assert.equal(sessionsDb.getSessionById('app'), null, 'deletion during the authority reread discards all writes');
  } finally {
    remove(); closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
