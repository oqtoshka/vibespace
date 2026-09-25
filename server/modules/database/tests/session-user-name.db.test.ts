import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';

/**
 * A name the user chose is final until the user renames again. On 2026-09-24 a
 * session renamed to "MC Features" from Mission Control came back as
 * "Commander-mode completion": the recap helper read the row before the
 * rename, answered minutes later, and wrote its 'ai' title over it. These tests
 * pin the guard at the storage layer, where no caller can race around it.
 */

const PROJECT_PATH = '/workspace/user-name-project';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'user-name-db-'));

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

const nameOf = (id: string) => {
  const row = sessionsDb.getSessionById(id);
  return { name: row?.custom_name, source: row?.name_source };
};

test('an automatic title never replaces a user rename, and a new rename still does', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-1', 'claude', PROJECT_PATH, false, false, 'first message');
    assert.equal(sessionsDb.updateSessionCustomName('app-1', 'Generated title', 'ai'), true);
    assert.equal(sessionsDb.updateSessionCustomName('app-1', 'MC Features'), true);

    assert.equal(sessionsDb.updateSessionCustomName('app-1', 'Commander-mode completion', 'ai'), false);
    assert.equal(sessionsDb.updateSessionCustomName('app-1', 'a prompt', 'derived'), false);
    assert.deepEqual(nameOf('app-1'), { name: 'MC Features', source: 'user' });

    assert.equal(sessionsDb.updateSessionCustomName('app-1', 'Renamed again', 'user'), true);
    assert.deepEqual(nameOf('app-1'), { name: 'Renamed again', source: 'user' });
  });
});

test('a transcript sync keeps a user rename on app and CLI sessions, whatever it offers', async () => {
  await withIsolatedDatabase(() => {
    // App session: row id differs from the provider id.
    sessionsDb.createAppSession('app-2', 'claude', PROJECT_PATH, false, false, 'first message');
    sessionsDb.assignProviderSessionId('app-2', 'provider-2');
    sessionsDb.updateSessionCustomName('app-2', 'MC Features');
    for (const source of ['provider', 'ai', 'derived'] as const) {
      sessionsDb.createSession('provider-2', 'claude', PROJECT_PATH, `Synced ${source}`, undefined, undefined, null, source as never);
    }
    assert.deepEqual(nameOf('app-2'), { name: 'MC Features', source: 'user' });

    // CLI session: row id is the provider id, which the app-session rule skips.
    sessionsDb.createSession('cli-3', 'claude', PROJECT_PATH, 'From the CLI', undefined, undefined, null, 'ai');
    sessionsDb.updateSessionCustomName('cli-3', 'Chosen name');
    sessionsDb.createSession('cli-3', 'claude', PROJECT_PATH, 'Newer AI title', undefined, undefined, null, 'ai');
    sessionsDb.createSession('cli-3', 'claude', PROJECT_PATH, 'last prompt', undefined, undefined, null, 'derived');
    assert.deepEqual(nameOf('cli-3'), { name: 'Chosen name', source: 'user' });

    // Without a user name the existing upgrade path is unchanged.
    sessionsDb.createSession('cli-4', 'claude', PROJECT_PATH, 'last prompt', undefined, undefined, null, 'derived');
    sessionsDb.createSession('cli-4', 'claude', PROJECT_PATH, 'Real title', undefined, undefined, null, 'ai');
    assert.deepEqual(nameOf('cli-4'), { name: 'Real title', source: 'ai' });
  });
});
