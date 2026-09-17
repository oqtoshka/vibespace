import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
import { sessionsService } from '@/modules/providers/index.js';
import { parseStoredLaunchOptions } from '@/shared/agent-env.js';

/**
 * Plugin-declared launch options are decided at creation exactly like
 * `private`: written with the row as JSON, read back by the launch, and never
 * updated. The repository stores what it is given; validating ids against the
 * declared options is the routes' job (see normalizeLaunchOptions).
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
