import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { createPluginRunReservation } from '@/modules/plugins/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { handleChatConnection, serverEnqueueMessageIfIdle } from '@/modules/websocket/services/chat-websocket.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';
import { FakeSocket } from '@/modules/websocket/tests/peer-message-fixture.js';

/*
 * Cross-repository integration, like peer-message-delivery.integration.ts:
 * NOT named `*.test.ts`, run with `npm run test:peer-integration` and
 * `MC_PEER_PLUGIN_ROOT=<plugin checkout>`. Without that variable it fails.
 *
 * The joined Janitor cleanup path in one process: the plugin's real cleanup
 * admission and guard → this host's real `runs.reserve` / `runs.get` over the
 * real run registry → a real `chat.send` and `chat.queue-add` arriving while the
 * mutation is in flight. And the owner-check half: the plugin's real scheduler
 * and owner check → this host's real `runs.onCompleted` and
 * `enqueueMessageIfIdle`, with only the reporter child replaced by a fixture.
 */
const pluginRoot = process.env.MC_PEER_PLUGIN_ROOT;

async function loadPlugin() {
  assert.ok(pluginRoot, 'MC_PEER_PLUGIN_ROOT must point at the plugin checkout');
  const lease = await import(pathToFileURL(path.join(pluginRoot, 'host/resource-owner-cleanup-lease.js')).href);
  return lease.createResourceOwnerCleanupAdmission as (options: Record<string, unknown>) =>
    (input: Record<string, unknown>, mutate: (options: unknown) => Promise<unknown>) => Promise<unknown>;
}

async function withDatabase(runTest: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'janitor-cleanup-integration-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  try {
    await runTest();
  } finally {
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

function hostOverRealRegistry() {
  return {
    sessions: { getById: (id: string) => sessionsDb.getSessionById(id) },
    runs: {
      get: (id: string) => {
        const run = chatRunRegistry.getRun(id);
        return run ? { status: run.status, providerSessionId: run.providerSessionId, lastAssistantText: '' } : null;
      },
      reserve: createPluginRunReservation(chatRunRegistry),
    },
  };
}

async function frame(socket: FakeSocket, payload: Record<string, unknown>): Promise<void> {
  for (const listener of socket.listeners('message') as Array<(raw: unknown) => unknown>) {
    await listener(Buffer.from(JSON.stringify(payload)));
  }
}

test('joined: a briefing session is cleaned up under a real lease; sends during it are deferred, then delivered', async () => {
  const createAdmission = await loadPlugin();
  await withDatabase(async () => {
    sessionsDb.createAppSession('brief', 'claude', '/workspace/demo', false, false, null, { 'mission-control.briefing': true });
    sessionsDb.assignProviderSessionId('brief', 'native-brief');
    const spawned: string[] = [];
    const socket = new FakeSocket();
    handleChatConnection(socket as never, { user: { id: 1 } } as never, {
      runtime: {
        hasRuntime: () => true,
        run: async (_provider: string, content: string) => { spawned.push(content); },
        abort: async () => true,
        resolveToolApproval: () => {},
        getPendingApprovalsForSession: () => [],
      },
    } as never);

    const admit = createAdmission({ host: hostOverRealRegistry() });
    let mutated = 0;
    const result = await admit({ sessionId: 'brief', providerSessionId: 'native-brief', id: 'res-1', generation: 'gen-1' }, async () => {
      mutated += 1;
      await frame(socket, { type: 'chat.send', sessionId: 'brief', clientMsgId: 'during', content: 'typed mid-cleanup', options: {} });
      await frame(socket, { type: 'chat.queue-add', sessionId: 'brief', id: 'q-during', content: 'queued mid-cleanup', options: {} });
      assert.deepEqual(spawned, [], 'no turn started while the mutation ran');
      return { ok: true };
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(mutated, 1);
    const refusal = socket.sent.find((sent) => sent.kind === 'protocol_error');
    assert.equal(refusal?.code, 'RUN_ADMISSION_RESERVED', 'the send was told why, not "already running"');
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(spawned, ['queued mid-cleanup'], 'the release drained what was queued during the cleanup');
  });
});

test('joined: a disk-discovered or chat-mode session is refused before any lease or mutation', async () => {
  const createAdmission = await loadPlugin();
  await withDatabase(async () => {
    sessionsDb.createSession('native-disk', 'claude', '/workspace/demo', 'from a terminal');
    sessionsDb.createAppSession('chat', 'claude', '/workspace/demo');
    sessionsDb.assignProviderSessionId('chat', 'native-chat');
    const admit = createAdmission({ host: hostOverRealRegistry() });
    for (const [sessionId, providerSessionId] of [['native-disk', 'native-disk'], ['chat', 'native-chat']]) {
      let mutated = 0;
      await assert.rejects(
        admit({ sessionId, providerSessionId, id: 'res-1', generation: 'gen-1' }, async () => { mutated += 1; }),
        /briefing sessions/,
        sessionId,
      );
      assert.equal(mutated, 0, `${sessionId}: never mutated`);
      assert.equal(chatRunRegistry.isAdmissionReserved(sessionId), false, `${sessionId}: no lease taken`);
    }
  });
});

/** The plugin's Janitor refuses outright under MC_DISABLE (a private session);
 * these tests are about the enabled path, so they run without it. */
function withoutMcDisable(t: { after: (fn: () => void) => void }): void {
  const saved = process.env.MC_DISABLE;
  delete process.env.MC_DISABLE;
  t.after(() => { if (saved !== undefined) process.env.MC_DISABLE = saved; });
}

async function loadOwnerCheck() {
  assert.ok(pluginRoot, 'MC_PEER_PLUGIN_ROOT must point at the plugin checkout');
  const check = await import(pathToFileURL(path.join(pluginRoot, 'host/resource-owner-check.js')).href);
  const scheduler = await import(pathToFileURL(path.join(pluginRoot, 'host/resource-owner-scheduler.js')).href);
  return { createResourceOwnerCheck: check.createResourceOwnerCheck, createResourceOwnerScheduler: scheduler.createResourceOwnerScheduler };
}

/** The reporter child's `module-resources` answers for one owner with one idle scratch directory. */
function reporterFixture(nativeId: string, calls: Array<Record<string, unknown>>) {
  const resource = { id: '11111111-1111-4111-8111-111111111111', generation: '22222222-2222-4222-8222-222222222222' };
  const request = '33333333-3333-4333-8333-333333333333';
  return async (command: string, input: Record<string, unknown>) => {
    assert.equal(command, 'module-resources');
    calls.push(input);
    if (input.action === 'need-eligibility') return { sessionId: nativeId, provider: 'claude', eligible: true, observedAt: Date.now() };
    if (input.action === 'need-prepare') return { state: 'prepared', id: request, generation: resource.generation, expiresAt: Date.now() + 60_000 };
    if (input.action === 'need-claim') return { state: 'dispatching', id: request, generation: resource.generation };
    if (input.action === 'need-delivery') return { ok: true };
    return { resources: [{ ...resource, ownerSessionId: nativeId, ownerCheckEligible: true, consumers: [],
      kind: 'scratch-directory', state: 'allocated', label: 'scratch' }] };
  };
}

test('joined: a briefing turn completing makes the scheduler ask its owner once, through the real idle-only admission', async (t) => {
  withoutMcDisable(t);
  const { createResourceOwnerCheck, createResourceOwnerScheduler } = await loadOwnerCheck();
  await withDatabase(async () => {
    sessionsDb.createAppSession('brief', 'claude', '/workspace/demo', false, false, null, { 'mission-control.briefing': true });
    sessionsDb.assignProviderSessionId('brief', 'native-brief');
    sessionsDb.createAppSession('chat', 'claude', '/workspace/demo');
    sessionsDb.assignProviderSessionId('chat', 'native-chat');
    const spawned: Array<{ session: unknown; content: string }> = [];
    const socket = new FakeSocket();
    handleChatConnection(socket as never, { user: { id: 1 } } as never, {
      runtime: {
        hasRuntime: () => true,
        run: async (_provider: string, content: string, options: { sessionId?: unknown }) => { spawned.push({ session: options?.sessionId, content }); },
        abort: async () => true,
        resolveToolApproval: () => {},
        getPendingApprovalsForSession: () => [],
      },
    } as never);
    const calls: Array<Record<string, unknown>> = [];
    const host = {
      sessions: { getById: (id: string) => sessionsDb.getSessionById(id) },
      runs: { onCompleted: (callback: (id: string) => void) => chatRunRegistry.addRunCompleteListener(callback) },
      enqueueMessageIfIdle: serverEnqueueMessageIfIdle,
    };
    const scheduler = createResourceOwnerScheduler({
      host, enabled: true, settleDelayMs: 0, readOptIn: async () => true,
      check: createResourceOwnerCheck({ host, call: reporterFixture('native-brief', calls) }),
    });
    const handle = scheduler.start();
    assert.equal(handle.started, true);
    try {
      await frame(socket, { type: 'chat.send', sessionId: 'brief', clientMsgId: 'b1', content: 'do the briefing work', options: {} });
      await frame(socket, { type: 'chat.send', sessionId: 'chat', clientMsgId: 'c1', content: 'plain chat', options: {} });
      for (let i = 0; i < 100 && spawned.length < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      await new Promise((resolve) => setTimeout(resolve, 50));
      const owner = spawned.filter((entry) => entry.content.startsWith('[Mission Control resource-owner check]'));
      assert.equal(owner.length, 1, 'exactly one owner check, for the briefing session only');
      assert.ok(calls.every((input) => input.sessionId === 'native-brief'), 'the chat-mode session never reached the reporter');
      assert.deepEqual(calls.filter((input) => input.action === 'need-delivery').map((input) => input.accepted), [true]);
    } finally {
      handle.stop();
    }
  });
});

test('joined: the owner check never queues behind a cleanup lease; it records the delivery as not accepted', async (t) => {
  withoutMcDisable(t);
  const { createResourceOwnerCheck } = await loadOwnerCheck();
  await withDatabase(async () => {
    sessionsDb.createAppSession('brief', 'claude', '/workspace/demo', false, false, null, { 'mission-control.briefing': true });
    sessionsDb.assignProviderSessionId('brief', 'native-brief');
    const spawned: string[] = [];
    const socket = new FakeSocket();
    handleChatConnection(socket as never, { user: { id: 1 } } as never, {
      runtime: {
        hasRuntime: () => true,
        run: async (_provider: string, content: string) => { spawned.push(content); },
        abort: async () => true,
        resolveToolApproval: () => {},
        getPendingApprovalsForSession: () => [],
      },
    } as never);
    await frame(socket, { type: 'chat.send', sessionId: 'brief', clientMsgId: 'b1', content: 'work', options: {} });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const lease = createPluginRunReservation(chatRunRegistry)('brief', {
      providerSessionId: 'native-brief', purpose: 'test', resource: { id: 'r', generation: 'g' }, ttlMs: 5_000,
    });
    assert.ok(lease);
    const calls: Array<Record<string, unknown>> = [];
    const check = createResourceOwnerCheck({
      host: { sessions: { getById: (id: string) => sessionsDb.getSessionById(id) }, enqueueMessageIfIdle: serverEnqueueMessageIfIdle },
      call: reporterFixture('native-brief', calls),
    });
    const result = await check('brief');
    assert.equal(result.state, 'uncertain');
    assert.deepEqual(calls.filter((input) => input.action === 'need-delivery').map((input) => input.accepted), [false]);
    lease?.release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(chatRunRegistry.getQueueForClient('brief').length, 0, 'nothing was queued to fire after the lease');
    assert.equal(chatRunRegistry.isProcessing('brief'), false, 'and nothing started on release');
  });
});
