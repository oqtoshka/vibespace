import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';

import { scheduleSessionRecap, cancelSessionRecap } from '../services/session-recap.service.js';

// The clock moves while helper replies remain manually controlled. This models
// a long turn with repeated prose and a slow recap request, without real sleeps.
test('progress cannot starve recaps or lose the refresh arriving during generation', async (t) => {
  const previous = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(tmpdir(), 'recap-schedule-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
  sessionsDb.createAppSession('live', 'codex', directory, 'first words');
  sessionsDb.assignProviderSessionId('live', 'provider-live');
  sessionsDb.createAppSession('private', 'codex', directory, 'private', true);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100_000 });
  let count = 2;
  let calls = 0;
  let finish: () => void = () => {};
  const input = {
    sessionId: 'live', cwd: directory, useIndexedHistory: true,
    fetchHistory: async (_id: string, options: { limit: number; offset: number }) => {
      const messages = Array.from({ length: count }, (_, i) => ({ id: `m-${i}`, kind: 'text',
        role: i === 0 ? 'user' : 'assistant', content: i === 0 ? 'Fix live recaps' : `Progress ${i}` }));
      const end = Math.max(0, count - options.offset);
      return { total: count, messages: messages.slice(Math.max(0, end - options.limit), end) };
    },
    runQuery: async (_prompt: string, _options: unknown, writer: { send: (data: unknown) => void }) => {
      calls++;
      await new Promise<void>(resolve => { finish = resolve; });
      writer.send({ kind: 'text', content: JSON.stringify({ title: 'Live Recaps', recap: `Recap ${calls}`, topics: [], kinds: [] }) });
    },
  };
  try {
    scheduleSessionRecap(input);
    t.mock.timers.tick(10_000);
    scheduleSessionRecap({ ...input, sessionId: 'provider-live' });
    t.mock.timers.tick(5_000);
    await setImmediate();
    assert.equal(calls, 1, 'repeated progress must not move the first deadline');

    count = 3;
    scheduleSessionRecap(input);
    t.mock.timers.tick(20_000);
    await setImmediate();
    assert.equal(calls, 1, 'only one helper runs for a session');
    finish();
    await setImmediate();
    assert.equal(sessionsDb.getSessionById('live')?.recap_message_count, 2);
    t.mock.timers.tick(39_999);
    await setImmediate();
    assert.equal(calls, 1, 'progress refreshes are limited to once a minute');
    t.mock.timers.tick(1);
    await setImmediate();
    assert.equal(calls, 2, 'progress during an in-flight helper schedules another pass');
    finish();
    await setImmediate();
    assert.equal(sessionsDb.getSessionById('live')?.recap_message_count, 3);

    scheduleSessionRecap(input);
    t.mock.timers.tick(60_000);
    await setImmediate();
    assert.equal(calls, 2, 'unchanged history never incurs another model call');

    count = 4;
    scheduleSessionRecap(input);
    cancelSessionRecap('live');
    scheduleSessionRecap({ ...input, sessionId: 'private' });
    t.mock.timers.tick(60_000);
    await setImmediate();
    assert.equal(calls, 2, 'cancelled and private sessions do not start helpers');
  } finally {
    finish();
    cancelSessionRecap('live');
    cancelSessionRecap('private');
    t.mock.timers.reset();
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
