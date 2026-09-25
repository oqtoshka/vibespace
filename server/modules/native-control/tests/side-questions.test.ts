import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import express from 'express';

import { appConfigDb, closeConnection, getConnection, initializeDatabase, sessionsDb, userDb } from '@/modules/database/index.js';
import { sessionShredService } from '@/modules/providers/index.js';
import { sessionCapabilityExpiry, sideCapabilityExpiry } from '@/modules/session-capabilities/index.js';

import { nativeControlRoutes, registerSideRunControl } from '../index.js';
import { nativeControlService } from '../native-control.service.js';
import { sideQuestionsService, sideSessionContext } from '../side-questions.service.js';

const token = 'x'.repeat(40);

test('native side questions: create under a parent, refuse private, promote, close and sweep', async () => {
  const previous = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(homedir(), '.native-side-test-'));
  closeConnection(); process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  const shred = mock.method(sessionShredService, 'execute', async (row: { session_id: string }) => {
    sessionsDb.deleteSessionById(row.session_id);
    return { sessionId: row.session_id, provider: 'claude', providerSessionId: null, deleted: [], notRemoved: [] };
  });
  const aborted: string[] = [];
  const running = new Set<string>();
  registerSideRunControl({ abort: async id => { aborted.push(id); running.delete(id); return true; }, isRunning: id => running.has(id) });
  try {
    await initializeDatabase();
    userDb.createUser('operator', 'unused');
    appConfigDb.set('mc_federation_token', token);

    const parentId = randomUUID();
    sessionsDb.createAppSession(parentId, 'claude', directory, false, false, 'Parent');
    sessionsDb.assignProviderSessionId(parentId, 'claude-parent-provider');
    const privateId = randomUUID();
    sessionsDb.createAppSession(privateId, 'claude', directory, false, true, 'Private');
    const codexParent = randomUUID();
    sessionsDb.createAppSession(codexParent, 'codex', directory, false, false, 'Codex');
    sessionsDb.assignProviderSessionId(codexParent, 'codex-thread');
    const freshParent = randomUUID();
    sessionsDb.createAppSession(freshParent, 'opencode', directory, false, false, 'Fresh');

    const app = express(); app.use(express.json()); app.use('/native', nativeControlRoutes);
    const server = app.listen(0);
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/native`;
      const call = (method: string, url: string, body?: unknown) => fetch(base + url, {
        method, headers: { 'x-mc-federation-token': token, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });

      // Create: an is_side row in the parent's project and provider, linked to it.
      const requestId = randomUUID();
      const response = await call('POST', `/sessions/${parentId}/side`, { requestId });
      assert.equal(response.status, 200);
      const created = await response.json() as { sessionId: string; provider: string; contextMode: string; capability: string };
      assert.equal(created.provider, 'claude');
      assert.equal(created.contextMode, 'fork');
      assert.match(created.capability, /^side1\./);
      const sideRow = sessionsDb.getSessionById(created.sessionId)!;
      assert.equal(sideRow.is_side, 1);
      assert.equal(sideRow.is_private, 0);
      assert.equal(sideRow.project_path, sessionsDb.getSessionById(parentId)!.project_path);
      assert.equal(sessionsDb.getSideParent(created.sessionId), parentId);
      assert.deepEqual(sideSessionContext(created.sessionId), {
        parentId, parentProviderSessionId: 'claude-parent-provider', parentJsonlPath: null, contextMode: 'fork',
      });

      // The side credential opens only this side session and never the owner surface.
      assert.notEqual(sideCapabilityExpiry(created.sessionId, created.capability), null);
      assert.equal(sessionCapabilityExpiry(created.sessionId, created.capability), null);
      assert.equal(sideCapabilityExpiry(parentId, created.capability), null);
      assert.throws(() => nativeControlService.describe(created.sessionId), /unavailable/);

      // Idempotent on (parent, requestId); a fresh requestId is a new side question.
      const again = await (await call('POST', `/sessions/${parentId}/side`, { requestId })).json() as { sessionId: string };
      assert.equal(again.sessionId, created.sessionId);
      const other = await (await call('POST', `/sessions/${parentId}/side`, { requestId: randomUUID() })).json() as { sessionId: string };
      assert.notEqual(other.sessionId, created.sessionId);

      // Context mode per provider.
      assert.equal(sideQuestionsService.create(codexParent, { requestId: randomUUID() }).contextMode, 'excerpt');
      assert.equal(sideQuestionsService.create(freshParent, { requestId: randomUUID() }).contextMode, 'none');

      // Refusals: private (MC_DISABLE) parent, a side as parent, archived, missing, bad input.
      const refusedPrivate = await call('POST', `/sessions/${privateId}/side`, { requestId: randomUUID() });
      assert.equal(refusedPrivate.status, 400);
      assert.match((await refusedPrivate.json() as { error: string }).error, /unavailable/);
      assert.throws(() => sideQuestionsService.create(created.sessionId, { requestId: randomUUID() }), /unavailable/);
      assert.throws(() => sideQuestionsService.create(randomUUID(), { requestId: randomUUID() }), /unavailable/);
      assert.throws(() => sideQuestionsService.create(parentId, { requestId: 'not-a-uuid' }), /Invalid/);
      const archived = randomUUID();
      sessionsDb.createAppSession(archived, 'claude', directory, false, false, 'Archived');
      sessionsDb.updateSessionIsArchived(archived, true);
      assert.throws(() => sideQuestionsService.create(archived, { requestId: randomUUID() }), /unavailable/);
      const forbidden = await fetch(`${base}/sessions/${parentId}/side`, { method: 'POST',
        headers: { 'x-mc-federation-token': 'y'.repeat(40), 'content-type': 'application/json' }, body: JSON.stringify({ requestId: randomUUID() }) });
      assert.equal(forbidden.status, 403);

      // A parent that turns private revokes its side credentials.
      getConnection().prepare('UPDATE sessions SET is_private = 1 WHERE session_id = ?').run(parentId);
      assert.equal(sideCapabilityExpiry(created.sessionId, created.capability), null);
      getConnection().prepare('UPDATE sessions SET is_private = 0 WHERE session_id = ?').run(parentId);

      // Promote: an ordinary session, named, and the side credential stops working.
      const promoted = await (await call('POST', `/sessions/${other.sessionId}/promote`, {})).json() as { id: string; sessionId: string; name: string };
      assert.equal(promoted.id, other.sessionId);
      assert.equal(promoted.name, 'Side question');
      assert.equal(sessionsDb.getSessionById(other.sessionId)!.is_side, 0);
      assert.equal(nativeControlService.describe(other.sessionId).sessionId, other.sessionId);
      assert.equal((await (await call('POST', `/sessions/${other.sessionId}/promote`, {})).json() as { id: string }).id, other.sessionId);
      assert.equal((await call('POST', `/sessions/${parentId}/promote`, {})).status, 400);

      // Close: aborts only the side's own run, removes it; the parent is untouched.
      running.add(created.sessionId);
      const closed = await call('DELETE', `/sessions/${created.sessionId}/side`);
      assert.deepEqual(await closed.json(), { ok: true });
      assert.deepEqual(aborted, [created.sessionId]);
      assert.equal(sessionsDb.getSessionById(created.sessionId), null);
      assert.ok(sessionsDb.getSessionById(parentId));
      assert.equal((await call('DELETE', `/sessions/${created.sessionId}/side`)).status, 400);
      assert.equal((await call('DELETE', `/sessions/${other.sessionId}/side`)).status, 400, 'a promoted session is not closable');
      assert.equal((await call('DELETE', `/sessions/${parentId}/side`)).status, 400);

      // A side row that shares the parent's provider session keeps those records.
      const shared = sideQuestionsService.create(parentId, { requestId: randomUUID() }).sessionId;
      getConnection().prepare('UPDATE sessions SET provider_session_id = ? WHERE session_id = ?').run('claude-parent-provider', shared);
      const shredCalls = shred.mock.callCount();
      await sideQuestionsService.close(shared);
      assert.equal(shred.mock.callCount(), shredCalls);
      assert.equal(sessionsDb.getSessionById(shared), null);

      // Sweep: idle for 24 hours and not running → removed; promoted, running and fresh rows stay.
      const stale = sideQuestionsService.create(parentId, { requestId: randomUUID() }).sessionId;
      const busy = sideQuestionsService.create(parentId, { requestId: randomUUID() }).sessionId;
      const fresh = sideQuestionsService.create(parentId, { requestId: randomUUID() }).sessionId;
      const old = '2020-01-01 00:00:00';
      for (const id of [stale, busy, other.sessionId]) {
        getConnection().prepare('UPDATE sessions SET updated_at = ? WHERE session_id = ?').run(old, id);
      }
      running.add(busy);
      const removed = await sideQuestionsService.sweep();
      assert.deepEqual(removed, [stale]);
      assert.equal(sessionsDb.getSessionById(stale), null);
      assert.ok(sessionsDb.getSessionById(busy));
      assert.ok(sessionsDb.getSessionById(fresh));
      assert.ok(sessionsDb.getSessionById(other.sessionId));
      // A turn keeps a side question alive.
      running.delete(busy);
      sessionsDb.touchSideSession(busy);
      assert.deepEqual(await sideQuestionsService.sweep(), []);
    } finally { server.close(); }
  } finally {
    shred.mock.restore();
    registerSideRunControl({ abort: async () => false, isRunning: () => true });
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
