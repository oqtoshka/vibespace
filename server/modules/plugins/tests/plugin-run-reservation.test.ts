import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { createPluginRunReservation } from '@/modules/plugins/services/plugin-run-reservation.service.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';

async function withSession(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'plugin-run-reservation-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  try {
    sessionsDb.createAppSession('owner', 'claude', '/workspace/demo');
    sessionsDb.assignProviderSessionId('owner', 'native');
    await runTest();
  } finally {
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const reserve = createPluginRunReservation(chatRunRegistry);
const request = { providerSessionId: 'native', purpose: 'resource-cleanup', resource: { id: 'r1', generation: 'g1' }, ttlMs: 20_000 };

test('host.runs.reserve returns a bound lease that attests coversAllRunStarts and holds every VibeSpace start', async () => {
  await withSession(() => {
    const before = Date.now();
    const lease = reserve('owner', request);
    assert.ok(lease);
    assert.equal(lease.sessionId, 'owner');
    assert.equal(lease.providerSessionId, 'native');
    assert.deepEqual(lease.resource, { id: 'r1', generation: 'g1' });
    assert.equal(lease.purpose, 'resource-cleanup');
    assert.equal(lease.coversAllRunStarts, true, 'operator-approved attestation (2026-09-24)');
    assert.ok(lease.expiresAt >= before + 20_000 && lease.expiresAt <= Date.now() + 20_000);
    assert.equal(chatRunRegistry.startQueuedRun('owner'), null, 'held');
    assert.equal(reserve('owner', { ...request, resource: { id: 'r2', generation: 'g' } }), null, 'one lease per session');
    lease.release();
    lease.release();
    assert.ok(chatRunRegistry.startQueuedRun('owner'), 'released');
  });
});

test('host.runs.reserve refuses malformed requests and a foreign source without a partial grant', async () => {
  await withSession(() => {
    for (const bad of [
      undefined, null, {}, { ...request, providerSessionId: 'other' }, { ...request, providerSessionId: 1 },
      { ...request, resource: null }, { ...request, resource: { id: 'r1' } }, { ...request, resource: { id: '', generation: 'g' } },
      { ...request, ttlMs: '20000' }, { ...request, ttlMs: 0 }, { ...request, ttlMs: 60_001 },
    ]) {
      assert.equal(reserve('owner', bad), null, JSON.stringify(bad));
    }
    assert.equal(reserve('missing', request), null);
    assert.equal(chatRunRegistry.isAdmissionReserved('owner'), false, 'no refusal left a reservation behind');
  });
});

test('runs.onCompleted fires for each completed run and stops after unsubscribe', async () => {
  await withSession(async () => {
    const seen: string[] = [];
    const unsubscribe = chatRunRegistry.addRunCompleteListener((id) => {
      seen.push(id);
      throw new Error('an observer failure stays isolated');
    });
    assert.ok(chatRunRegistry.startQueuedRun('owner'));
    chatRunRegistry.completeRun('owner', { exitCode: 0 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(seen, ['owner']);
    unsubscribe();
    assert.ok(chatRunRegistry.startQueuedRun('owner'));
    chatRunRegistry.completeRun('owner', { exitCode: 0 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(seen, ['owner']);
  });
});
