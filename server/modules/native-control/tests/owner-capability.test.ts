import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import express from 'express';

import { appConfigDb, closeConnection, initializeDatabase, sessionsDb, userDb } from '@/modules/database/index.js';

import { nativeControlRoutes } from '../index.js';
import { nativeControlService } from '../native-control.service.js';

test('owner capability distinguishes confirmed absence, privacy refusals and failed observations', async () => {
  const previous = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(tmpdir(), 'owner-capability-'));
  closeConnection(); process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await writeFile(process.env.DATABASE_PATH, ''); // Never import the workstation's legacy database.
  const app = express(); app.use('/native', nativeControlRoutes);
  const server = app.listen(0);
  try {
    await initializeDatabase();
    userDb.createUser('operator', 'unused');
    const federation = 'f'.repeat(40);
    appConfigDb.set('mc_federation_token', federation);
    const active = randomUUID(), archived = randomUUID(), missing = randomUUID();
    const privateId = randomUUID(), side = randomUUID();
    for (const id of [active, archived]) sessionsDb.createAppSession(id, 'codex', directory);
    sessionsDb.createAppSession(privateId, 'codex', directory, false, true);
    sessionsDb.createAppSession(side, 'codex', directory, true);
    sessionsDb.updateSessionIsArchived(archived, true);
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/native/sessions/`;
    const lookup = (id: string, headers: Record<string, string> = { 'x-mc-federation-token': federation }) =>
      fetch(url + id + '/owner-capability', { headers });

    for (const [id, state] of [[active, 'active'], [archived, 'archived']] as const) {
      const response = await lookup(id);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), { sessionId: id, state, capability: nativeControlService.describe(id).capability });
    }
    const absent = await lookup(missing);
    assert.equal(absent.status, 200);
    assert.deepEqual(await absent.json(), { sessionId: missing, state: 'missing' });
    for (const id of [privateId, side, 'invalid']) {
      const refused = await lookup(id);
      assert.equal(refused.status, 400);
      const body = await refused.json() as Record<string, unknown>;
      assert.equal('capability' in body, false);
      assert.equal('state' in body, false);
    }
    assert.equal((await lookup(active, {})).status, 403);
    assert.equal((await lookup(active, { 'x-mc-federation-token': federation, origin: 'https://browser.invalid' })).status, 403);
    const ordinary = sessionsDb.getSessionById(active)!;
    const unknown = mock.method(sessionsDb, 'getSessionById', () => ({ ...ordinary, is_private: undefined }) as never);
    try { assert.throws(() => nativeControlService.ownerCapability(active), /unavailable/); }
    finally { unknown.mock.restore(); }
    const failed = mock.method(sessionsDb, 'getSessionById', () => { throw new Error('fixture database unavailable'); });
    try {
      const response = await lookup(active);
      assert.equal(response.status, 400);
      const body = await response.json() as Record<string, unknown>;
      assert.equal('state' in body, false, 'read failure must not confirm absence');
    } finally { failed.mock.restore(); }
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
