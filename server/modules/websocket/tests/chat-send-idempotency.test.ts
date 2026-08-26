import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';

/**
 * A socket that records what was written to it. `readyState` is OPEN so the
 * service's `sendJson` guard lets frames through, exactly like a live client.
 */
class FakeSocket extends EventEmitter {
  readyState = 1;
  sent: Array<Record<string, unknown>> = [];

  send(payload: string): void {
    this.sent.push(JSON.parse(payload) as Record<string, unknown>);
  }

  framesOfKind(kind: string): Array<Record<string, unknown>> {
    return this.sent.filter((frame) => frame.kind === kind);
  }
}

type SpawnCall = { content: string };

function buildDependencies(spawnCalls: SpawnCall[]) {
  const spawn = async (content: string): Promise<void> => {
    spawnCalls.push({ content });
  };

  return {
    runtime: {
      hasRuntime: () => true,
      run: async (_provider: string, content: string) => spawn(content),
      abort: async () => true,
      resolveToolApproval: () => {},
      getPendingApprovalsForSession: () => [],
    },
  } as unknown as Parameters<typeof handleChatConnection>[2];
}

async function withIsolatedDatabase(runTest: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'chat-send-idempotency-'));

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

/** Drives one `chat.send` through the connection handler and waits for it. */
async function send(
  socket: FakeSocket,
  frame: Record<string, unknown>,
): Promise<void> {
  const listeners = socket.listeners('message') as Array<(raw: unknown) => unknown>;
  for (const listener of listeners) {
    await listener(Buffer.from(JSON.stringify(frame)));
  }
}

// The regression: a proxy restart drops the socket after the frame is read but
// before the ack is written, so the client re-sends on reconnect. That resend
// must be recognised rather than run a second time — the user's message would
// otherwise be answered twice.
test('a chat.send replayed with the same clientMsgId is re-acked, not run again', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('session-resend', 'claude', '/workspace/demo', 'Resend');

    const spawnCalls: SpawnCall[] = [];
    const dependencies = buildDependencies(spawnCalls);

    const first = new FakeSocket();
    handleChatConnection(first as never, { user: { id: 1 } } as never, dependencies);
    await send(first, {
      type: 'chat.send',
      sessionId: 'session-resend',
      clientMsgId: 'send_abc',
      content: 'hey',
      options: {},
    });

    assert.equal(spawnCalls.length, 1, 'the first send starts a run');
    assert.equal(first.framesOfKind('send_ack').length, 1);

    // The reconnect: a new socket replaying the identical frame.
    const second = new FakeSocket();
    handleChatConnection(second as never, { user: { id: 1 } } as never, dependencies);
    await send(second, {
      type: 'chat.send',
      sessionId: 'session-resend',
      clientMsgId: 'send_abc',
      content: 'hey',
      options: {},
    });

    assert.equal(spawnCalls.length, 1, 'the replay must not start a second run');

    const acks = second.framesOfKind('send_ack');
    assert.equal(acks.length, 1, 'the replay is acked so the client stops waiting');
    assert.equal(acks[0]?.clientMsgId, 'send_abc');
    assert.equal(
      second.framesOfKind('protocol_error').length,
      0,
      'and is not bounced as RUN_IN_PROGRESS, which the client answers by queueing it again',
    );
  });
});

test('a distinct clientMsgId in the same session still starts its own run', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('session-distinct', 'claude', '/workspace/demo', 'Distinct');

    const spawnCalls: SpawnCall[] = [];
    const dependencies = buildDependencies(spawnCalls);

    const socket = new FakeSocket();
    handleChatConnection(socket as never, { user: { id: 1 } } as never, dependencies);

    await send(socket, {
      type: 'chat.send',
      sessionId: 'session-distinct',
      clientMsgId: 'send_one',
      content: 'first',
      options: {},
    });
    await send(socket, {
      type: 'chat.send',
      sessionId: 'session-distinct',
      clientMsgId: 'send_two',
      content: 'second',
      options: {},
    });

    assert.deepEqual(spawnCalls.map((call) => call.content), ['first', 'second']);
  });
});
