import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { closeConnection, initializeDatabase, projectsDb } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { connectedClients } from '@/modules/websocket/index.js';

const PROJECT_PATH = '/workspace/demo-project';

/** Long enough for the watcher's 500 ms broadcast debounce to fire. */
const FLUSH_WAIT_MS = 900;

async function withIsolatedDatabase(runTest: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'new-session-'));

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

/** Minimal stand-in for a browser on the other end of the websocket. */
function attachFakeClient(): { frames: Array<Record<string, unknown>>; detach: () => void } {
  const frames: Array<Record<string, unknown>> = [];
  const client = {
    readyState: 1,
    send: (data: string) => {
      frames.push(JSON.parse(data));
    },
  };

  connectedClients.add(client as never);
  return { frames, detach: () => connectedClients.delete(client as never) };
}

// The sidebar is fed by the transcript watcher, which only ever hears about a
// session once the provider has written something for it. A brand-new chat has
// nothing on disk yet, so without an announcement of its own it stayed
// invisible until the user reloaded the page.
test('a newly allocated session is announced to the sidebar immediately', async () => {
  await withIsolatedDatabase(async () => {
    projectsDb.createProjectPath(PROJECT_PATH);
    const client = attachFakeClient();

    try {
      const { sessionId } = sessionsService.createAppSession('opencode', PROJECT_PATH);
      await delay(FLUSH_WAIT_MS);

      const upserted = client.frames.filter((frame) => frame.kind === 'session_upserted');
      assert.equal(upserted.length, 1);
      assert.equal(upserted[0].sessionId, sessionId);
      // The provider is read off the row, not assumed — the frontend files the
      // session into a per-provider list and would drop an unknown one.
      assert.equal(upserted[0].provider, 'opencode');
      // The owning project has to ride along: it is what the frontend inserts
      // the session under when it is not already on any list.
      assert.equal((upserted[0].project as { path: string } | null)?.path, PROJECT_PATH);
    } finally {
      client.detach();
    }
  });
});

// `/btw` sessions are deliberately absent from the lists until promoted.
test('a side session is not announced', async () => {
  await withIsolatedDatabase(async () => {
    projectsDb.createProjectPath(PROJECT_PATH);
    const client = attachFakeClient();

    try {
      sessionsService.createAppSession('claude', PROJECT_PATH, true);
      await delay(FLUSH_WAIT_MS);

      assert.deepEqual(client.frames.filter((frame) => frame.kind === 'session_upserted'), []);
    } finally {
      client.detach();
    }
  });
});
