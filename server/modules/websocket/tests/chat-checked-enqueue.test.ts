import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry, registerChatDependenciesAtBoot, serverEnqueueMessageChecked } from '@/modules/websocket/index.js';

test('checked enqueue answers an outcome and queues nothing it would drop', async () => {
  const previous = process.env.DATABASE_PATH;
  const temporary = await mkdtemp(path.join(tmpdir(), 'vs-checked-enqueue-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(temporary, 'auth.db');
  await initializeDatabase();
  const calls: string[] = [];
  const releases: Array<() => void> = [];
  let unavailable = false;
  registerChatDependenciesAtBoot({runtime: {
    hasRuntime: () => !unavailable,
    run: async (_provider: string, content: string) => {
      calls.push(content);
      await new Promise<void>(resolve => releases.push(resolve));
    },
    abort: async () => true,
    resolveToolApproval: () => {},
    getPendingApprovalsForSession: () => [],
  }} as unknown as Parameters<typeof registerChatDependenciesAtBoot>[0]);
  try {
    assert.deepEqual(serverEnqueueMessageChecked('absent', 'Hello'), {outcome: 'missing'});

    sessionsDb.createSession('idle', 'claude', '/workspace/fixture', 'idle');
    assert.deepEqual(serverEnqueueMessageChecked('idle', 'Wake up'), {outcome: 'accepted', recipientBusy: false});
    assert.deepEqual(calls, ['Wake up'], 'an idle session drains the accepted message at once');

    // The drained turn is still running: a second message is accepted behind it.
    assert.deepEqual(serverEnqueueMessageChecked('idle', 'Second'), {outcome: 'accepted', recipientBusy: true});
    assert.deepEqual(chatRunRegistry.getQueueForClient('idle').map(item => item.content), ['Second']);

    sessionsDb.createSession('no-runtime', 'claude', '/workspace/fixture', 'no-runtime');
    unavailable = true;
    assert.deepEqual(serverEnqueueMessageChecked('no-runtime', 'Lost'), {outcome: 'runtime-unavailable'});
    assert.equal(chatRunRegistry.hasQueued('no-runtime'), false, 'a refusal queues nothing');
    unavailable = false;

    for (let i = chatRunRegistry.getQueueForClient('idle').length; i < 20; i += 1) {
      assert.equal(serverEnqueueMessageChecked('idle', `fill ${i}`).outcome, 'accepted');
    }
    assert.deepEqual(serverEnqueueMessageChecked('idle', 'Overflow'), {outcome: 'queue-full'});
    assert.equal(chatRunRegistry.getQueueForClient('idle')[0].content, 'Second', 'the cap refuses instead of evicting the oldest');
  } finally {
    chatRunRegistry.clearQueue('idle', 'aborted');
    for (const release of releases) release();
    await new Promise(resolve => setImmediate(resolve));
    chatRunRegistry.clearAll();
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
    await rm(temporary, {recursive: true, force: true});
  }
});
