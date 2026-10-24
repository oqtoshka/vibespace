import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// One scratch database for the whole file. It is DATABASE_PATH before the chat
// modules load, since one of them opens the database as it loads, and stays so
// to the end, since a finished run reads it again a moment later.
const tempDirectory = await mkdtemp(path.join(tmpdir(), 'chat-send-archived-'));
const previousDatabasePath = process.env.DATABASE_PATH;
process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');

const { closeConnection, initializeDatabase, sessionsDb } = await import('@/modules/database/index.js');
const { closeSessionsWatcher } = await import('@/modules/providers/index.js');
const { chatRunRegistry } = await import('@/modules/websocket/index.js');
const { handleChatConnection } = await import('@/modules/websocket/services/chat-websocket.service.js');

test.before(async () => {
  closeConnection();
  await initializeDatabase();
});

test.after(async () => {
  // A finished run hands its session to the queue drain and the peer outbox a
  // tick later: let them read this database, then cancel the pending sidebar
  // broadcast, so nothing opens a database once it is gone.
  await new Promise((resolve) => setTimeout(resolve, 20));
  await closeSessionsWatcher();
  chatRunRegistry.clearAll();
  closeConnection();
  if (previousDatabasePath === undefined) {
    delete process.env.DATABASE_PATH;
  } else {
    process.env.DATABASE_PATH = previousDatabasePath;
  }
  await rm(tempDirectory, { recursive: true, force: true });
});

/** A socket that is open and records nothing the tests need to read. */
class FakeSocket extends EventEmitter {
  readyState = 1;
  send(): void {}
}

function connect(runs: string[]): FakeSocket {
  const socket = new FakeSocket();
  handleChatConnection(socket as never, { user: { id: 1 } } as never, {
    runtime: {
      hasRuntime: () => true,
      run: async (_provider: string, content: string) => { runs.push(content); },
      abort: async () => true,
      resolveToolApproval: () => {},
      getPendingApprovalsForSession: () => [],
    },
  } as unknown as Parameters<typeof handleChatConnection>[2]);
  return socket;
}

async function deliver(socket: FakeSocket, frame: Record<string, unknown>): Promise<void> {
  for (const listener of socket.listeners('message') as Array<(raw: unknown) => unknown>) {
    await listener(Buffer.from(JSON.stringify(frame)));
  }
}

function archivedSession(sessionId: string): void {
  sessionsDb.createSession(sessionId, 'claude', '/workspace/demo', 'Archived');
  sessionsDb.updateSessionIsArchived(sessionId, true);
}

test('sending into an archived conversation brings it back to the sidebar', async () => {
  archivedSession('session-archived-send');
  const runs: string[] = [];

  await deliver(connect(runs), {
    type: 'chat.send',
    sessionId: 'session-archived-send',
    clientMsgId: 'send_archived',
    content: 'picking this up again',
    options: {},
  });

  assert.deepEqual(runs, ['picking this up again']);
  assert.equal(sessionsDb.getSessionById('session-archived-send')?.isArchived, 0);
});

test('a message queued into an archived conversation brings it back too', async () => {
  archivedSession('session-archived-queue');
  const runs: string[] = [];

  await deliver(connect(runs), {
    type: 'chat.queue-add',
    sessionId: 'session-archived-queue',
    id: 'queued_archived',
    content: 'and this after it',
    options: {},
  });
  // The idle session drains the queued message into a run of its own.
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sessionsDb.getSessionById('session-archived-queue')?.isArchived, 0);
  assert.deepEqual(runs, ['and this after it']);
});

test('an empty queue item is dropped and leaves the archive alone', async () => {
  archivedSession('session-archived-empty');
  const runs: string[] = [];

  await deliver(connect(runs), {
    type: 'chat.queue-add',
    sessionId: 'session-archived-empty',
    id: 'queued_empty',
    content: '   ',
    options: {},
  });

  assert.equal(sessionsDb.getSessionById('session-archived-empty')?.isArchived, 1);
  assert.deepEqual(runs, []);
});
