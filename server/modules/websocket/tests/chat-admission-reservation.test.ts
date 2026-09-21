import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

class FakeConnection {
  readyState = 1;
  send(): void {}
}

async function withSession(runTest: (id: string) => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'chat-admission-reservation-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  try {
    sessionsDb.createAppSession('owner', 'claude', '/workspace/demo');
    sessionsDb.assignProviderSessionId('owner', 'native');
    await runTest('owner');
  } finally {
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const reserve = (overrides: Partial<Parameters<typeof chatRunRegistry.reserveAdmission>[0]> = {}) => {
  const bound = sessionsDb.getSessionById('owner')?.provider_session_id ?? '';
  return chatRunRegistry.reserveAdmission({
    appSessionId: 'owner', providerSessionId: bound, resourceId: 'r1', generation: 'g1', ttlMs: 20_000, ...overrides,
  });
};
const startRaw = () => chatRunRegistry.startRun({
  appSessionId: 'owner', provider: 'claude', providerSessionId: null, connection: new FakeConnection() as never, userId: 'u',
});

test('a held reservation refuses every registry start path, and release re-admits', async () => {
  await withSession(() => {
    const lease = reserve();
    assert.ok(lease);
    assert.equal(startRaw(), null, 'chat.send start refused');
    assert.equal(chatRunRegistry.startQueuedRun('owner'), null, 'queue drain refused');
    assert.equal(chatRunRegistry.startResumeRun('owner'), null, 'background auto-resume refused');
    lease.release();
    assert.ok(startRaw(), 'released: the next turn starts');
  });
});

test('a reservation is refused while a run is active, while work is queued, or when already held', async () => {
  await withSession(() => {
    const run = startRaw();
    assert.ok(run);
    assert.equal(reserve(), null, 'running');
    chatRunRegistry.completeRun('owner', { exitCode: 0 });
    const first = reserve();
    assert.ok(first);
    assert.equal(reserve({ resourceId: 'r2' }), null, 'duplicate cleanup of any resource is refused');
    first.release();
    chatRunRegistry.enqueue('owner', { id: 'q1', content: 'next', createdAt: Date.now() } as never);
    assert.equal(reserve(), null, 'queued work');
  });
});

test('expiry frees the session without a release, and a stale release cannot free a newer lease', async () => {
  await withSession(async () => {
    const stale = reserve({ ttlMs: 20 });
    assert.ok(stale);
    assert.equal(startRaw(), null);
    await new Promise((resolve) => setTimeout(resolve, 40));
    const fresh = reserve();
    assert.ok(fresh, 'the expired lease no longer blocks');
    stale.release();
    assert.equal(startRaw(), null, 'the stale token did not release the fresh lease');
    fresh.release();
  });
});

test('invalid TTLs, missing identity and a rebound session are refused', async () => {
  await withSession(() => {
    for (const ttlMs of [0, -1, Number.NaN, 60_001]) assert.equal(reserve({ ttlMs }), null, String(ttlMs));
    assert.equal(reserve({ resourceId: '' }), null);
    assert.equal(reserve({ generation: '' }), null);
    assert.equal(reserve({ providerSessionId: 'someone-else' }), null, 'rebound or foreign source');
    assert.equal(chatRunRegistry.reserveAdmission({ appSessionId: 'missing', providerSessionId: 'x', resourceId: 'r', generation: 'g', ttlMs: 1000 }), null);
  });
});
