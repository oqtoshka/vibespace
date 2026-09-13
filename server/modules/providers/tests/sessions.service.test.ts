import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'sessions-service-db-'));

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

test('provider session id returns the mapped native id', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-session-id', 'codex', '/tmp/session-id-copy-project');
    sessionsDb.assignProviderSessionId('app-session-id', 'codex-native-session-id');

    assert.equal(sessionsService.getProviderSessionId('app-session-id'), 'codex-native-session-id');
  });
});

test('app session names use at most four whole words from the initial message', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    const result = sessionsService.createAppSession(
      'codex',
      '/tmp/session-name-project',
      '  supercalifragilisticexpialidocious\nsecond   third fourth fifth  ',
    );

    assert.equal(result.sessionName, 'supercalifragilisticexpialidocious second third fourth');
    assert.equal(
      sessionsDb.getSessionById(result.sessionId)?.custom_name,
      'supercalifragilisticexpialidocious second third fourth',
    );
  });
});

test('app sessions without message text receive a stable fallback name', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    const result = sessionsService.createAppSession('claude', '/tmp/attachment-only-project', '  \n ');

    assert.equal(result.sessionName, 'Untitled Session');
    assert.equal(sessionsDb.getSessionById(result.sessionId)?.custom_name, 'Untitled Session');
  });
});

test('a stale client send replaces a provider placeholder with the first prompt', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('stale-client-session', 'codex', '/tmp/session-name-project');
    sessionsDb.updateSessionCustomName('stale-client-session', 'Untitled Codex Session', 'derived');

    assert.equal(
      sessionsService.seedDerivedSessionNameFromMessage(
        'stale-client-session',
        'remove the open source footer everywhere',
      ),
      'remove the open source',
    );

    const row = sessionsDb.getSessionById('stale-client-session');
    assert.equal(row?.custom_name, 'remove the open source');
    assert.equal(row?.name_source, 'derived');
  });
});

test('a stale client send does not overwrite a user or AI title', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('named-session', 'opencode', '/tmp/session-name-project');
    sessionsDb.updateSessionCustomName('named-session', 'Checkout Crash', 'ai');

    assert.equal(
      sessionsService.seedDerivedSessionNameFromMessage('named-session', 'a later prompt'),
      'Checkout Crash',
    );
    assert.equal(sessionsDb.getSessionById('named-session')?.name_source, 'ai');
  });
});

test('provider session id is unavailable until the provider assigns one', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('pending-app-session', 'claude', '/tmp/session-id-copy-project');

    assert.throws(
      () => sessionsService.getProviderSessionId('pending-app-session'),
      (error: unknown) => {
        const typedError = error as { code?: string; statusCode?: number };
        return typedError.code === 'PROVIDER_SESSION_ID_NOT_AVAILABLE' && typedError.statusCode === 409;
      },
    );
  });
});

test('provider session id reports a missing app session', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    assert.throws(
      () => sessionsService.getProviderSessionId('missing-session'),
      (error: unknown) => {
        const typedError = error as { code?: string; statusCode?: number };
        return typedError.code === 'SESSION_NOT_FOUND' && typedError.statusCode === 404;
      },
    );
  });
});

test('recent sessions map project metadata and preserve database pagination', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession(
      'older-session',
      'claude',
      '/tmp/recent-project',
      'Older conversation',
      '2026-08-01T08:00:00.000Z',
      '2026-08-01T09:00:00.000Z',
    );
    sessionsDb.createSession(
      'newer-session',
      'codex',
      '/tmp/recent-project',
      'Newer conversation',
      '2026-08-01T10:00:00.000Z',
      '2026-08-01T11:00:00.000Z',
    );
    projectsDb.updateCustomProjectName('/tmp/recent-project', 'Recent Project');

    const project = projectsDb.getProjectPath('/tmp/recent-project');
    const page = sessionsService.listRecentSessions(1, 0);

    assert.deepEqual(page, {
      conversations: [{
        sessionId: 'newer-session',
        provider: 'codex',
        projectId: project?.project_id ?? null,
        projectDisplayName: 'Recent Project',
        sessionTitle: 'Newer conversation',
        lastActivity: '2026-08-01T11:00:00.000Z',
      }],
      total: 2,
      hasMore: true,
    });
  });
});

test('history read without a limit returns only the newest 2000 messages and keeps paging', { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sessions-service-history-cap-'));
  const transcript = path.join(root, 'rollout.jsonl');
  // 1,300 turns of user + assistant = 2,600 normalized messages.
  const entries = Array.from({ length: 1_300 }, (_, turn) => [
    { type: 'event_msg', payload: { type: 'user_message', message: `Question ${turn}` } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `Answer ${turn}` }] } },
  ]).flat();

  try {
    await writeFile(transcript, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
    await withIsolatedDatabase(async () => {
      const id = sessionsDb.createSession('history-cap', 'codex', root, 'History cap', undefined, undefined, transcript);

      const unbounded = await sessionsService.fetchHistory(id);
      assert.equal(unbounded.messages.length, 2_000);
      assert.equal(unbounded.total, 2_600);
      assert.equal(unbounded.hasMore, true);
      assert.equal(unbounded.limit, 2_000);
      assert.equal(unbounded.messages.at(-1)?.content, 'Answer 1299');

      // The client continues from where the capped read stopped.
      const older = await sessionsService.fetchHistory(id, { limit: 20, offset: unbounded.messages.length });
      assert.equal(older.messages.length, 20);
      assert.equal(older.messages.at(-1)?.content, 'Answer 299');

      const page = await sessionsService.fetchHistory(id, { limit: 20, offset: 0 });
      assert.equal(page.messages.length, 20);
      assert.equal(page.hasMore, true);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
