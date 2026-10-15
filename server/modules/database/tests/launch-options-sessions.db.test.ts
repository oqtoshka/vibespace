import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
import { sessionsService } from '@/modules/providers/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import { parseStoredLaunchOptions, registerLaunchOption } from '@/shared/agent-env.js';

/**
 * Plugin-declared launch options are chosen at creation like `private`:
 * written with the row as JSON and read back by every launch. An option its
 * plugin declares `switchable` may later be turned on or off in an existing
 * session (the chat ↔ briefing switch); the next turn reads the row. The
 * repository stores what it is given; validating ids against the declared
 * options is the routes' and the service's job (see normalizeLaunchOptions,
 * switchSessionLaunchOptions).
 */

const PROJECT_PATH = '/workspace/launch-options-project';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'launch-options-sessions-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('launch options are stored with the row as JSON and default to none', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('plain', 'claude', PROJECT_PATH);
    sessionsDb.createAppSession('empty', 'claude', PROJECT_PATH, false, false, null, {});
    sessionsDb.createAppSession('flag', 'claude', PROJECT_PATH, false, false, null, { 'acme.review': true });
    sessionsDb.createAppSession('valued', 'codex', PROJECT_PATH, false, false, null, { 'acme.review': { depth: 'deep' } });

    assert.equal(sessionsDb.getSessionById('plain')?.launch_options, null);
    assert.equal(sessionsDb.getSessionById('empty')?.launch_options, null);
    assert.deepEqual(parseStoredLaunchOptions(sessionsDb.getSessionById('flag')?.launch_options), { 'acme.review': true });
    assert.deepEqual(parseStoredLaunchOptions(sessionsDb.getSessionById('valued')?.launch_options), { 'acme.review': { depth: 'deep' } });
  });
});

test('the service passes the choice through and reports it back', async () => {
  await withIsolatedDatabase(() => {
    const created = sessionsService.createAppSession('opencode', PROJECT_PATH, false, false, 'Ship it', { 'acme.review': true });
    assert.deepEqual(created.launchOptions, { 'acme.review': true });
    assert.equal(created.isPrivate, false);

    const ordinary = sessionsService.createAppSession('opencode', PROJECT_PATH);
    assert.equal(ordinary.launchOptions, null);
    assert.equal(sessionsDb.getSessionById(ordinary.sessionId)?.launch_options, null);

    // A private session with launch options is both: the choices are independent.
    const both = sessionsService.createAppSession('claude', PROJECT_PATH, false, true, undefined, { 'acme.review': true });
    const row = sessionsDb.getSessionById(both.sessionId);
    assert.equal(row?.is_private, 1);
    assert.deepEqual(parseStoredLaunchOptions(row?.launch_options), { 'acme.review': true });
  });
});

test('the options survive the provider id being assigned and the row being read back by it', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('mapped', 'claude', PROJECT_PATH, false, false, null, { 'acme.review': true });
    sessionsDb.assignProviderSessionId('mapped', 'claude-native-launch-options');

    const row = sessionsDb.getSessionByProviderSessionId('claude-native-launch-options');
    assert.deepEqual(parseStoredLaunchOptions(row?.launch_options), { 'acme.review': true });
  });
});

test('a pre-existing database gains the column', async () => {
  await withIsolatedDatabase(async () => {
    const db = getConnection();
    db.exec('ALTER TABLE sessions DROP COLUMN launch_options');
    closeConnection();
    await initializeDatabase();
    sessionsDb.createAppSession('after', 'claude', PROJECT_PATH, false, false, null, { 'acme.review': true });
    assert.deepEqual(parseStoredLaunchOptions(sessionsDb.getSessionById('after')?.launch_options), { 'acme.review': true });
  });
});

test('the repository updates the options of an ordinary session only', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('main', 'claude', PROJECT_PATH);
    sessionsDb.createAppSession('side', 'claude', PROJECT_PATH, true);
    sessionsDb.createAppSession('private', 'claude', PROJECT_PATH, false, true);

    assert.equal(sessionsDb.updateSessionLaunchOptions('main', { 'acme.briefing': true }), true);
    assert.deepEqual(parseStoredLaunchOptions(sessionsDb.getSessionById('main')?.launch_options), { 'acme.briefing': true });
    assert.equal(sessionsDb.updateSessionLaunchOptions('main', {}), true);
    assert.equal(sessionsDb.getSessionById('main')?.launch_options, null, 'empty is stored as none');

    assert.equal(sessionsDb.updateSessionLaunchOptions('side', { 'acme.briefing': true }), false);
    assert.equal(sessionsDb.updateSessionLaunchOptions('private', { 'acme.briefing': true }), false);
    assert.equal(sessionsDb.updateSessionLaunchOptions('missing', { 'acme.briefing': true }), false);
    assert.equal(sessionsDb.getSessionById('side')?.launch_options, null);
    assert.equal(sessionsDb.getSessionById('private')?.launch_options, null);
  });
});

test('the service switches a switchable option on and off in an existing Claude session', async () => {
  const stop = registerLaunchOption({ id: 'acme.briefing', label: 'briefing', switchable: true });
  const stopFixed = registerLaunchOption({ id: 'acme.fixed', label: 'fixed' });
  try {
    await withIsolatedDatabase(() => {
      const { sessionId } = sessionsService.createAppSession('claude', PROJECT_PATH, false, false, undefined, { 'acme.fixed': true });

      const on = sessionsService.switchLaunchOptions(sessionId, { 'acme.briefing': true });
      assert.deepEqual(on, { sessionId, launchOptions: { 'acme.fixed': true, 'acme.briefing': true }, changed: true });
      assert.deepEqual(parseStoredLaunchOptions(sessionsDb.getSessionById(sessionId)?.launch_options), { 'acme.fixed': true, 'acme.briefing': true });

      const again = sessionsService.switchLaunchOptions(sessionId, { 'acme.briefing': true });
      assert.equal(again.changed, false, 'asking for what is there changes nothing');

      const off = sessionsService.switchLaunchOptions(sessionId, { 'acme.briefing': false });
      assert.deepEqual(off.launchOptions, { 'acme.fixed': true });

      assert.throws(() => sessionsService.switchLaunchOptions(sessionId, { 'acme.fixed': false }),
        (error: any) => error.statusCode === 400 && /cannot be changed/.test(error.message));
      assert.throws(() => sessionsService.switchLaunchOptions(sessionId, 'briefing'),
        (error: any) => error.statusCode === 400);
      assert.throws(() => sessionsService.switchLaunchOptions('no-such-session', { 'acme.briefing': true }),
        (error: any) => error.statusCode === 404);
    });
  } finally {
    stop();
    stopFixed();
  }
});

test('the service refuses side, private, non-Claude and busy sessions', async () => {
  const stop = registerLaunchOption({ id: 'acme.briefing', label: 'briefing', switchable: true });
  try {
    await withIsolatedDatabase(() => {
      const conflict = (error: any) => error.statusCode === 409;
      const side = sessionsService.createAppSession('claude', PROJECT_PATH, true);
      assert.throws(() => sessionsService.switchLaunchOptions(side.sessionId, { 'acme.briefing': true }), conflict);
      const hidden = sessionsService.createAppSession('claude', PROJECT_PATH, false, true);
      assert.throws(() => sessionsService.switchLaunchOptions(hidden.sessionId, { 'acme.briefing': true }), conflict);
      for (const provider of ['codex', 'opencode', 'cursor'] as const) {
        const other = sessionsService.createAppSession(provider, PROJECT_PATH);
        assert.throws(() => sessionsService.switchLaunchOptions(other.sessionId, { 'acme.briefing': true }),
          (error: any) => error.statusCode === 409 && /starts/.test(error.message), provider);
        assert.equal(sessionsDb.getSessionById(other.sessionId)?.launch_options, null);
      }

      // A held turn admission counts as a turn in flight.
      const busy = sessionsService.createAppSession('claude', PROJECT_PATH);
      sessionsDb.assignProviderSessionId(busy.sessionId, 'claude-native-busy');
      const lease = chatRunRegistry.reserveAdmission({
        appSessionId: busy.sessionId, providerSessionId: 'claude-native-busy', resourceId: 'test', generation: '1', ttlMs: 5_000,
      });
      assert.ok(lease);
      try {
        assert.throws(() => sessionsService.switchLaunchOptions(busy.sessionId, { 'acme.briefing': true }),
          (error: any) => error.statusCode === 409 && error.code === 'SESSION_TURN_IN_FLIGHT');
        assert.equal(sessionsDb.getSessionById(busy.sessionId)?.launch_options, null);
      } finally {
        lease.release();
      }
      assert.equal(sessionsService.switchLaunchOptions(busy.sessionId, { 'acme.briefing': true }).changed, true);
    });
  } finally {
    stop();
  }
});
