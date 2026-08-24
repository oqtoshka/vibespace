import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
import { sessionsService } from '@/modules/providers/index.js';

/**
 * A private session (FEAT-INGEST-006) is decided at creation and never
 * changes: the flag is written with the row and read back by everything that
 * decides whether the session may leave a trace outside the harness. Unlike a
 * side session it stays on every list — private is not hidden.
 */

const PROJECT_PATH = '/workspace/private-project';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'private-sessions-db-'));
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

test('the private flag is stored with the row and defaults to off', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('plain-session', 'claude', PROJECT_PATH);
    sessionsDb.createAppSession('private-session', 'codex', PROJECT_PATH, false, true);

    assert.equal(sessionsDb.getSessionById('plain-session')?.is_private, 0);
    assert.equal(sessionsDb.getSessionById('private-session')?.is_private, 1);
  });
});

test('the service passes the flag through and reports it back', async () => {
  await withIsolatedDatabase(() => {
    const created = sessionsService.createAppSession('opencode', PROJECT_PATH, false, true);
    assert.equal(created.isPrivate, true);
    assert.equal(created.isSide, false);
    assert.equal(sessionsDb.getSessionById(created.sessionId)?.is_private, 1);

    const ordinary = sessionsService.createAppSession('opencode', PROJECT_PATH);
    assert.equal(ordinary.isPrivate, false);
    assert.equal(sessionsDb.getSessionById(ordinary.sessionId)?.is_private, 0);
  });
});

test('a private session stays on the project lists', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('private-listed', 'claude', PROJECT_PATH, false, true);

    const listed = sessionsDb.getSessionsByProjectPath(PROJECT_PATH).map((row) => row.session_id);
    assert.deepEqual(listed, ['private-listed']);
    const paged = sessionsDb.getSessionsByProjectPathPage(PROJECT_PATH, 50, 0);
    assert.equal(paged[0]?.is_private, 1);
  });
});

test('the flag survives the provider id being assigned and the row being read back by it', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('private-mapped', 'claude', PROJECT_PATH, false, true);
    sessionsDb.assignProviderSessionId('private-mapped', 'claude-native-private');

    assert.equal(sessionsDb.getSessionByProviderSessionId('claude-native-private')?.is_private, 1);
  });
});
