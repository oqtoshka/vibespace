import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry, registerChatDependenciesAtBoot, serverEnqueueMessageIfIdle } from '@/modules/websocket/index.js';

test('idle-only follow-ups do not use missing boot dependencies as evidence of idleness', () => {
  assert.equal(serverEnqueueMessageIfIdle('not-observed', 'native', 'Owner check'), false);
});

test('idle admission respects operator work, permissions, privacy and source identity across CLIs', async () => {
  const previous = process.env.DATABASE_PATH;
  const temporary = await mkdtemp(path.join(tmpdir(), 'vs-idle-enqueue-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(temporary, 'auth.db');
  await initializeDatabase();
  const calls: Array<{provider: string; content: string; permissionMode: unknown}> = [];
  const releases: Array<() => void> = [];
  let pending: unknown[] = [];
  let unavailable = false;
  let readFailed = false;
  registerChatDependenciesAtBoot({runtime: {
    hasRuntime: () => !unavailable,
    run: async (provider, content, options) => {
      calls.push({provider, content, permissionMode: options.permissionMode});
      await new Promise<void>(resolve => releases.push(resolve));
    },
    abort: async () => true,
    resolveToolApproval: () => {},
    getPendingApprovalsForSession: () => { if (readFailed) throw new Error('Observation failed'); return pending; },
  }} as Parameters<typeof registerChatDependenciesAtBoot>[0]);
  function completed(id: string, provider: 'claude' | 'codex' | 'opencode' = 'claude') {
    sessionsDb.createSession(id, provider, '/workspace/fixture', id);
    const run = chatRunRegistry.startRun({appSessionId: id, provider, providerSessionId: id,
      connection: {readyState: 1, send() {}}, userId: null});
    assert.ok(run);
    chatRunRegistry.completeRun(id, {exitCode: 0});
    return run;
  }
  const send = (id: string) => serverEnqueueMessageIfIdle(id, id, 'Owner check');
  try {
    for (const provider of ['claude', 'codex', 'opencode'] as const) {
      const id = `idle-${provider}`;
      completed(id, provider);
      assert.equal(serverEnqueueMessageIfIdle(id, id, 'Owner check', {permissionMode: 'default'}), true);
      assert.equal(send(id), false, 'second admission sees the synchronously reserved run');
      assert.equal(chatRunRegistry.hasQueued(id), false, 'accepted message is already dispatched');
    }
    assert.deepEqual(calls.map(call => call.provider), ['claude', 'codex', 'opencode']);
    assert.ok(calls.every(call => call.content === 'Owner check' && call.permissionMode === 'default'));

    completed('queued');
    chatRunRegistry.enqueue('queued', {id: 'operator-message', content: 'My next task', imageCount: 0, options: {}, userId: null, createdAt: Date.now()});
    assert.equal(send('queued'), false);
    assert.deepEqual(chatRunRegistry.getQueueForClient('queued').map(item => item.id), ['operator-message']);

    completed('question'); pending = [{requestId: 'permission'}];
    assert.equal(send('question'), false); pending = [];
    completed('unknown'); readFailed = true;
    assert.equal(send('unknown'), false); readFailed = false;
    completed('missing-runtime'); unavailable = true;
    assert.equal(send('missing-runtime'), false); unavailable = false;
    sessionsDb.createSession('no-run', 'claude', '/workspace/fixture', 'No run');
    assert.equal(send('no-run'), false);
    assert.equal(send('deleted'), false);
    completed('private'); getConnection().prepare('UPDATE sessions SET is_private = 1 WHERE session_id = ?').run('private');
    assert.equal(send('private'), false);
    completed('archived'); getConnection().prepare('UPDATE sessions SET isArchived = 1 WHERE session_id = ?').run('archived');
    assert.equal(send('archived'), false);
    completed('changed-identity');
    assert.equal(serverEnqueueMessageIfIdle('changed-identity', 'foreign-native', 'Owner check'), false);
    completed('changed-run').providerSessionId = 'another-native';
    assert.equal(send('changed-run'), false);
    completed('reserved');
    const lease = chatRunRegistry.reserveAdmission({appSessionId: 'reserved', providerSessionId: 'reserved', resourceId: 'r', generation: 'g', ttlMs: 5_000});
    assert.ok(lease, 'the Janitor cleanup holds the session');
    assert.equal(send('reserved'), false, 'an owner check never queues behind a cleanup lease');
    lease.release();
    completed('blank');
    assert.equal(serverEnqueueMessageIfIdle('blank', 'blank', ' '), false);
    assert.equal(calls.length, 3, 'none of the refused checks start a provider or enqueue a follow-up');
  } finally {
    chatRunRegistry.clearQueue('queued', 'aborted');
    for (const release of releases) release();
    await new Promise(resolve => setImmediate(resolve));
    chatRunRegistry.clearAll();
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
    await rm(temporary, {recursive: true, force: true});
  }
});
