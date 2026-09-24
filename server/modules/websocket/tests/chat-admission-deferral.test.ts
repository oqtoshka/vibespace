import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

/**
 * A turn refused by a turn-admission reservation is deferred, never dropped:
 * chat.send says why (and the client re-queues), and the reservation's end —
 * release or expiry — drains what it refused.
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

function buildDependencies(spawned: string[]) {
  return {
    runtime: {
      hasRuntime: () => true,
      run: async (_provider: string, content: string, _options: unknown, writer: { sendComplete?: () => void }) => {
        spawned.push(content);
        void writer;
      },
      abort: async () => true,
      resolveToolApproval: () => {},
      getPendingApprovalsForSession: () => [],
    },
  } as unknown as Parameters<typeof handleChatConnection>[2];
}

async function withSession(runTest: (socket: FakeSocket, spawned: string[]) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'chat-admission-deferral-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  try {
    sessionsDb.createAppSession('owner', 'claude', '/workspace/demo');
    sessionsDb.assignProviderSessionId('owner', 'native');
    const spawned: string[] = [];
    const socket = new FakeSocket();
    handleChatConnection(socket as never, { user: { id: 1 } } as never, buildDependencies(spawned));
    await runTest(socket, spawned);
  } finally {
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

async function frame(socket: FakeSocket, payload: Record<string, unknown>): Promise<void> {
  for (const listener of socket.listeners('message') as Array<(raw: unknown) => unknown>) {
    await listener(Buffer.from(JSON.stringify(payload)));
  }
}

const reserve = (ttlMs = 20_000) => chatRunRegistry.reserveAdmission({
  appSessionId: 'owner', providerSessionId: 'native', resourceId: 'r1', generation: 'g1', ttlMs,
});
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

test('chat.send under a reservation is refused as RUN_ADMISSION_RESERVED, not "already running"', async () => {
  await withSession(async (socket, spawned) => {
    const lease = reserve();
    assert.ok(lease);
    await frame(socket, { type: 'chat.send', sessionId: 'owner', clientMsgId: 'send_1', content: 'hi', options: {} });
    const errors = socket.framesOfKind('protocol_error');
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.code, 'RUN_ADMISSION_RESERVED');
    assert.doesNotMatch(String(errors[0]?.error), /already/i);
    assert.equal(spawned.length, 0, 'nothing ran under the reservation');
    assert.equal(socket.framesOfKind('send_ack').length, 0, 'not acked: the client re-queues it');
    lease.release();
  });
});

test('a real running turn still answers RUN_IN_PROGRESS', async () => {
  await withSession(async (socket) => {
    assert.ok(chatRunRegistry.startQueuedRun('owner'), 'a turn is running');
    await frame(socket, { type: 'chat.send', sessionId: 'owner', clientMsgId: 'send_b', content: 'two', options: {} });
    assert.equal(socket.framesOfKind('protocol_error')[0]?.code, 'RUN_IN_PROGRESS');
  });
});

test('a message queued during a reservation is drained when the reservation is released', async () => {
  await withSession(async (socket, spawned) => {
    const lease = reserve();
    assert.ok(lease);
    await frame(socket, { type: 'chat.queue-add', sessionId: 'owner', id: 'q1', content: 'queued while held', options: {} });
    await tick();
    assert.deepEqual(spawned, [], 'held: the drain was refused');
    assert.ok(chatRunRegistry.getQueued('owner', 'q1'), 'the item stays queued, not dropped');
    lease.release();
    await tick();
    assert.deepEqual(spawned, ['queued while held'], 'release re-drained the queue');
  });
});

test('a reservation that expires without a release still drains what it refused', async () => {
  await withSession(async (socket, spawned) => {
    assert.ok(reserve(30));
    await frame(socket, { type: 'chat.queue-add', sessionId: 'owner', id: 'q1', content: 'after expiry', options: {} });
    await tick();
    assert.deepEqual(spawned, []);
    await tick(80);
    assert.deepEqual(spawned, ['after expiry'], 'expiry fired the drain with no other trigger');
  });
});

test('whenAdmissionFree wakes on release and expiry, and a stale release wakes nobody', async () => {
  await withSession(async () => {
    assert.equal(await Promise.race([chatRunRegistry.whenAdmissionFree('owner').then(() => 'free'), tick(5).then(() => 'wait')]), 'free', 'unreserved: immediate');

    const lease = reserve();
    assert.ok(lease);
    let woken = 0;
    void chatRunRegistry.whenAdmissionFree('owner').then(() => { woken += 1; });
    await tick();
    assert.equal(woken, 0, 'held: parked');
    lease.release();
    await tick();
    assert.equal(woken, 1, 'release woke it');

    const expiring = reserve(20);
    assert.ok(expiring);
    void chatRunRegistry.whenAdmissionFree('owner').then(() => { woken += 1; });
    await tick(60);
    assert.equal(woken, 2, 'expiry woke it');

    const fresh = reserve();
    assert.ok(fresh);
    void chatRunRegistry.whenAdmissionFree('owner').then(() => { woken += 1; });
    expiring.release();
    await tick();
    assert.equal(woken, 2, 'the stale token neither released nor woke the fresh lease');
    assert.equal(chatRunRegistry.isAdmissionReserved('owner'), true);
    fresh.release();
    await tick();
    assert.equal(woken, 3);
  });
});

test('a message already handed to a running turn but not yet started refuses the reservation', async () => {
  await withSession(async () => {
    chatRunRegistry.enqueue('owner', { id: 'q1', content: 'in flight', createdAt: Date.now() } as never);
    chatRunRegistry.markDelivered('owner', 'q1', 'uuid-1');
    assert.equal(chatRunRegistry.hasQueued('owner'), false, 'delivered items are not "queued" for the drain');
    assert.equal(reserve(), null, 'but the runtime may still open a fresh turn for it');
  });
});
