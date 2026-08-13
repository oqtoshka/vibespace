import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { OpenCodeSessionSynchronizer } from '@/modules/providers/list/opencode/opencode-session-synchronizer.provider.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { getOpenCodeHelperWorkspace } from '@/shared/utils.js';

const PROJECT_PATH = '/workspace/notes';
const HELPER_SESSION_ID = 'ses_helper';

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as unknown as { homedir: () => string }).homedir = () => nextHomeDir;
  return () => {
    (os as unknown as { homedir: () => string }).homedir = original;
  };
};

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'recap-helper-db-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
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

/**
 * Just enough of opencode.db for the synchronizer: one session sitting in the
 * summariser's own workspace, which is where every background title/recap turn
 * runs.
 */
const createStoreWithHelperSession = async (homeDir: string, helperWorkspace: string): Promise<void> => {
  const dataDir = path.join(homeDir, '.local', 'share', 'opencode');
  await mkdir(dataDir, { recursive: true });

  const db = new Database(path.join(dataDir, 'opencode.db'));
  try {
    db.exec(`
      CREATE TABLE project (
        id TEXT PRIMARY KEY,
        worktree TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        sandboxes TEXT NOT NULL
      );

      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        parent_id TEXT,
        slug TEXT NOT NULL,
        directory TEXT NOT NULL,
        title TEXT NOT NULL,
        version TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        time_archived INTEGER,
        path TEXT,
        model TEXT
      );
    `);

    db.prepare('INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES (?, ?, ?, ?, ?)')
      .run('project-1', helperWorkspace, 1_700_000_000_000, 1_700_000_001_000, '[]');
    db.prepare(`
      INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      HELPER_SESSION_ID,
      'project-1',
      HELPER_SESSION_ID,
      helperWorkspace,
      'Recap helper turn',
      '0.0.0',
      1_700_000_002_000,
      1_700_000_003_000,
    );
  } finally {
    db.close();
  }
};

// The importer binds an unrecognised provider id to the newest unmapped app row
// of the same project. A summariser turn running in the user's project would
// therefore be adopted by a chat still waiting for its own provider id — and
// the helper's cleanup would delete that chat along with itself.
test('a summariser session is not imported and cannot claim a pending chat', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'recap-helper-home-'));
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    const helperWorkspace = getOpenCodeHelperWorkspace();
    await mkdir(helperWorkspace, { recursive: true });
    await createStoreWithHelperSession(tempRoot, helperWorkspace);

    await withIsolatedDatabase(() => {
      const { sessionId } = sessionsService.createAppSession('opencode', PROJECT_PATH);

      new OpenCodeSessionSynchronizer().synchronize();

      assert.equal(
        sessionsDb.getSessionByProviderSessionId(HELPER_SESSION_ID),
        null,
        'the helper turn must stay out of the sidebar entirely',
      );
      assert.equal(
        sessionsDb.getSessionById(sessionId)?.provider_session_id,
        null,
        'the chat waiting for its provider id must not have been handed the helper\'s',
      );
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

// Belt and braces for the same failure: even if some other path binds the
// helper id to a real chat, discarding the helper must not take the chat down
// with it.
test('discarding a helper session leaves an app-allocated row alone', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    const { sessionId } = sessionsService.createAppSession('opencode', PROJECT_PATH);
    sessionsDb.assignProviderSessionId(sessionId, HELPER_SESSION_ID);

    await sessionsService.discardProviderSession('opencode', HELPER_SESSION_ID);

    assert.ok(sessionsDb.getSessionById(sessionId), 'the user\'s conversation must survive');
  });
});

// The row the importer writes for a session nobody allocated is keyed by the
// provider id itself, and that one is the helper's to remove.
test('discarding a helper session drops the row the importer wrote for it', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession(
      HELPER_SESSION_ID,
      'opencode',
      PROJECT_PATH,
      'Recap helper turn',
      undefined,
      undefined,
      null,
    );
    assert.ok(sessionsDb.getSessionById(HELPER_SESSION_ID));

    await sessionsService.discardProviderSession('opencode', HELPER_SESSION_ID);

    assert.equal(sessionsDb.getSessionById(HELPER_SESSION_ID), null);
  });
});
