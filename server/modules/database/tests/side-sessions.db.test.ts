import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';

/**
 * Side sessions back a `/btw` question. They are ordinary sessions in every
 * respect except that they stay out of the session lists until the user
 * branches one out — these tests pin both halves of that contract.
 */

const PROJECT_PATH = '/workspace/btw-project';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'side-sessions-db-'));
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

test('a side session is hidden from every project session listing', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('ordinary-session', 'claude', PROJECT_PATH);
    sessionsDb.createAppSession('btw-session', 'claude', PROJECT_PATH, true);

    const listed = sessionsDb.getSessionsByProjectPath(PROJECT_PATH).map((row) => row.session_id);
    const paged = sessionsDb
      .getSessionsByProjectPathPage(PROJECT_PATH, 50, 0)
      .map((row) => row.session_id);

    assert.deepEqual(listed, ['ordinary-session']);
    assert.deepEqual(paged, ['ordinary-session']);
    assert.equal(sessionsDb.countSessionsByProjectPath(PROJECT_PATH), 1);

    // Hidden from the lists, but a real row the gateway can resolve — that is
    // what lets `chat.send` run against it like any other session.
    assert.equal(sessionsDb.getSessionById('btw-session')?.is_side, 1);
  });
});

test('a side session is never adopted as the pending session of a new chat', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('btw-session', 'claude', PROJECT_PATH, true);

    // Both rows have provider_session_id NULL; without the is_side guard the
    // btw row would be handed to the next brand-new chat in this project.
    assert.equal(sessionsDb.findLatestPendingAppSession('claude', PROJECT_PATH), null);
  });
});

test('promoting a side session makes it an ordinary one and names it', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('btw-session', 'claude', PROJECT_PATH, true);

    assert.equal(sessionsDb.promoteSideSession('btw-session', 'Why is the build slow?'), true);

    const promoted = sessionsDb.getSessionById('btw-session');
    assert.equal(promoted?.is_side, 0);
    assert.equal(promoted?.custom_name, 'Why is the build slow?');
    assert.equal(promoted?.name_source, 'derived');
    assert.deepEqual(
      sessionsDb.getSessionsByProjectPath(PROJECT_PATH).map((row) => row.session_id),
      ['btw-session'],
    );
  });
});

test('promoting never clobbers a name the session already has', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('btw-session', 'claude', PROJECT_PATH, true);
    sessionsDb.updateSessionCustomName('btw-session', 'Renamed by hand', 'user');

    sessionsDb.promoteSideSession('btw-session', 'Question text');

    const promoted = sessionsDb.getSessionById('btw-session');
    assert.equal(promoted?.custom_name, 'Renamed by hand');
    assert.equal(promoted?.name_source, 'user');
  });
});

test('promoting an already-ordinary session reports no change', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('ordinary-session', 'claude', PROJECT_PATH);

    assert.equal(sessionsDb.promoteSideSession('ordinary-session', 'Anything'), false);
    assert.equal(sessionsDb.getSessionById('ordinary-session')?.custom_name, null);
  });
});

test('the side flag survives the watcher indexing the transcript', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('btw-session', 'claude', PROJECT_PATH, true);
    sessionsDb.assignProviderSessionId('btw-session', 'provider-abc');

    // The synchronizer upserts by provider id when the transcript lands on
    // disk. If that path reset the flag, every answered btw would pop into the
    // sidebar a moment after it was asked.
    sessionsDb.createSession('provider-abc', 'claude', PROJECT_PATH, 'Provider title');

    assert.equal(sessionsDb.getSessionById('btw-session')?.is_side, 1);
    assert.deepEqual(sessionsDb.getSessionsByProjectPath(PROJECT_PATH), []);
  });
});
