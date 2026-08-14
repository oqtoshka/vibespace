import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { deleteSessionsForProjectPath } from '@/modules/providers/services/sessions.service.js';

const PROJECT_PATH = '/workspace/delete-me';

async function withIsolatedDatabase(runTest: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'session-project-delete-'));

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
 * Records which sessions each provider is asked to erase from its own store,
 * so the real OpenCode database is never touched by a test.
 */
function stubProviderStore(): { erased: string[]; restore: () => void } {
  const erased: string[] = [];
  const originalResolveProvider = providerRegistry.resolveProvider;

  providerRegistry.resolveProvider = ((provider: string) => ({
    id: provider,
    sessions: {
      deleteSession: async (providerSessionId: string) => {
        erased.push(`${provider}:${providerSessionId}`);
        return true;
      },
    },
  })) as unknown as typeof providerRegistry.resolveProvider;

  return {
    erased,
    restore: () => {
      providerRegistry.resolveProvider = originalResolveProvider;
    },
  };
}

test('deleting a project asks each provider to erase its own copy of the sessions', async () => {
  await withIsolatedDatabase(async () => {
    const store = stubProviderStore();

    try {
      projectsDb.createProjectPath(PROJECT_PATH);
      // Providers that keep every conversation in one shared store (OpenCode)
      // hold on to it after the app row goes, and the next synchronizer pass
      // imports it back — together with the project it belongs to.
      sessionsDb.createSession('opencode-1', 'opencode', PROJECT_PATH, 'Shared store');
      sessionsDb.createSession('opencode-2', 'opencode', PROJECT_PATH, 'Also shared');
      sessionsDb.updateSessionIsArchived('opencode-2', true);

      const deleted = await deleteSessionsForProjectPath(PROJECT_PATH);

      assert.equal(deleted, 2);
      assert.deepEqual(store.erased.sort(), ['opencode:opencode-1', 'opencode:opencode-2']);
      assert.equal(sessionsDb.getSessionsByProjectPathIncludingArchived(PROJECT_PATH).length, 0);
    } finally {
      store.restore();
    }
  });
});

test('a session the provider cannot erase still loses its app row', async () => {
  await withIsolatedDatabase(async () => {
    const originalResolveProvider = providerRegistry.resolveProvider;
    providerRegistry.resolveProvider = (() => {
      throw new Error('provider store unavailable');
    }) as unknown as typeof providerRegistry.resolveProvider;

    try {
      projectsDb.createProjectPath(PROJECT_PATH);
      sessionsDb.createSession('opencode-1', 'opencode', PROJECT_PATH, 'Shared store');

      await deleteSessionsForProjectPath(PROJECT_PATH);

      assert.equal(sessionsDb.getSessionsByProjectPathIncludingArchived(PROJECT_PATH).length, 0);
    } finally {
      providerRegistry.resolveProvider = originalResolveProvider;
    }
  });
});
