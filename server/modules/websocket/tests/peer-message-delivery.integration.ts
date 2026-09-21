import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { handleChatConnection, serverEnqueueMessage } from '@/modules/websocket/services/chat-websocket.service.js';

import {
  FakeSocket,
  legacyDatabaseFingerprint,
  recordingRuntime,
  type RuntimeCall,
  withIsolatedDatabase,
} from './peer-message-fixture.js';

/*
 * Cross-repository integration. Deliberately NOT named `*.test.ts`, so the
 * default `npm test` glob never picks it up and stays self-contained. Run it
 * explicitly with `npm run test:peer-integration` and
 * `MC_PEER_PLUGIN_ROOT=<plugin checkout>`; without that variable it fails —
 * it never skips.
 */
/**
 * The joined path — one process, no reimplementation of anything.
 *
 * Everything above proves one half. This proves them connected: the real
 * `mc-peer` CLI → HTTP over an ephemeral port → the plugin's real peer router
 * and its real capability check → the plugin's real `queuePeerMessage` →
 * **this module's** `serverEnqueueMessage` → **this module's** `drainQueue` →
 * the recording runtime. No stub transport and no copied queue algorithm takes
 * part in the acceptance.
 *
 * The plugin lives in another repository, so its location comes from
 * `MC_PEER_PLUGIN_ROOT` in the environment — no absolute path is committed here
 * and the test **fails** (never silently skips) when it is unset, so a green run
 * cannot mean "this never executed".
 */
const pluginRoot = process.env.MC_PEER_PLUGIN_ROOT ?? '';

async function loadPlugin(): Promise<{
  createSessionPeerRouter: (host: unknown, options?: { receiptDirectory?: string }) => unknown;
  sessionPeerCapability: (hmac: (input: string) => string, sessionId: string) => string;
  missionControlSessionCapability: (hmac: (input: string) => string, sessionId: string) => string;
  hmacUnderSecret: (secret: string) => (input: string) => string;
  peerCli: (argv: string[], env: NodeJS.ProcessEnv, fetchImpl: typeof fetch, io: { write: (line: string) => void; exit: (code: number) => void }) => Promise<unknown>;
  express: typeof import('express');
}> {
  assert.notEqual(pluginRoot, '',
    'MC_PEER_PLUGIN_ROOT must point at the peer plugin checkout; this test never skips');
  const url = (relative: string) => pathToFileURL(path.join(pluginRoot, relative)).href;
  const [router, capability, operatorCapability, cli] = await Promise.all([
    import(url('host/session-peer-router.js')),
    import(url('host/session-peer-capability.js')),
    import(url('host/mission-control-capability.js')),
    import(url('bin/mc-peer.mjs')),
  ]);
  // VibeSpace does not depend on the plugin's express; resolve it from there.
  const requireFromPlugin = createRequire(path.join(pluginRoot, 'package.json'));
  return {
    createSessionPeerRouter: router.createSessionPeerRouter,
    sessionPeerCapability: capability.sessionPeerCapability,
    missionControlSessionCapability: operatorCapability.missionControlSessionCapability,
    hmacUnderSecret: operatorCapability.hmacUnderSecret,
    peerCli: cli.main,
    express: requireFromPlugin('express'),
  };
}

/** The plugin host contract, backed by the real fixture database and this
 * module's real enqueue. Nothing here reimplements a queue. */
function pluginHost(plugin: Awaited<ReturnType<typeof loadPlugin>>, hmac: (input: string) => string) {
  return {
    createRouter: () => plugin.express.Router(),
    hmacSha256: hmac,
    warn: () => {},
    sessions: {
      getById: (id: string) => {
        const row = sessionsDb.getSessionById(id) as Record<string, unknown> | null;
        return row ? { ...row, isArchived: Boolean(row.is_archived) } : null;
      },
      listByProjectPath: (projectPath: string, limit: number) =>
        (sessionsDb.getAllSessions() as Array<Record<string, unknown>>)
          .filter((row) => row.project_path === projectPath)
          .slice(0, limit)
          .map((row) => ({ ...row, isArchived: Boolean(row.is_archived) })),
    },
    enqueueMessage: (id: string, prompt: string, options?: Record<string, unknown>) =>
      serverEnqueueMessage(id, prompt, options ?? {}),
  };
}

async function runCli(
  plugin: Awaited<ReturnType<typeof loadPlugin>>,
  argv: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; json: Record<string, unknown> }> {
  const out: string[] = [];
  let code = 0;
  await plugin.peerCli(argv, env, fetch, { write: (line) => out.push(line), exit: (value) => { code = value; } });
  return { code, json: JSON.parse(out.join('') || '{}') as Record<string, unknown> };
}

test('joined: the real CLI, the real peer router and this module\'s real queue deliver once', async (t) => {
  const plugin = await loadPlugin();
  const legacyBefore = await legacyDatabaseFingerprint();
  t.after(async () => assert.equal(await legacyDatabaseFingerprint(), legacyBefore, 'database/auth.db untouched'));
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('joined-sender', 'claude', '/workspace/demo', 'Sender');
    sessionsDb.createSession('joined-recipient', 'claude', '/workspace/demo', 'Recipient');
    sessionsDb.createSession('joined-elsewhere', 'claude', '/workspace/other', 'Elsewhere');

    const received: RuntimeCall[] = [];
    let release = () => {};
    const state: { hasRuntime: boolean; block?: Promise<void> } = { hasRuntime: true };
    handleChatConnection(new FakeSocket() as never, { user: { id: 1 } } as never, recordingRuntime(received, state));

    const hmac = plugin.hmacUnderSecret('joined-fixture-secret');
    const receipts = await mkdtemp(path.join(tmpdir(), 'joined-receipts-'));
    const app = plugin.express();
    app.use(plugin.express.json());
    app.use('/api/mission-control', plugin.createSessionPeerRouter(pluginHost(plugin, hmac), { receiptDirectory: receipts }) as never);
    const server = createServer(app);
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()); });
    t.after(() => { server.close(); return rm(receipts, { recursive: true, force: true }); });
    const port = (server.address() as { port: number }).port;
    const env = {
      MC_PEER_SESSION: 'joined-sender',
      MC_PEER_CAPABILITY: plugin.sessionPeerCapability(hmac, 'joined-sender'),
      MC_PEER_BASE_URL: `http://127.0.0.1:${port}`,
    };

    // Discovery is project-scoped through the real database.
    const peers = await runCli(plugin, ['peers'], env);
    assert.equal(peers.code, 0);
    assert.deepEqual((peers.json.peers as Array<{ sessionId: string }>).map((p) => p.sessionId), ['joined-recipient']);

    // Send: CLI → HTTP → router → queuePeerMessage → serverEnqueueMessage → drainQueue.
    const requestId = 'a'.repeat(64);
    const sent = await runCli(plugin, ['send', '--to', 'joined-recipient', '--text', 'the migration is green', '--request-id', requestId], env);
    assert.equal(sent.code, 0);
    assert.equal(sent.json.state, 'accepted');
    assert.equal(sent.json.delivery, 'unknown');
    assert.equal('delivered' in sent.json, false);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(received.length, 1, 'the recipient runtime ran it exactly once');
    assert.match(received[0].content, /the migration is green/);
    assert.match(received[0].content, /From: session joined-sender \(claude\)/, 'the authenticated sender, not a body field');
    assert.match(received[0].content, /\[Peer message from another agent session working in \/workspace\/demo\]/);

    // Retry with the same requestId: the receipt replays, nothing is re-run.
    const replay = await runCli(plugin, ['send', '--to', 'joined-recipient', '--text', 'the migration is green', '--request-id', requestId], env);
    assert.equal(replay.code, 0);
    assert.equal(replay.json.acceptedAt, sent.json.acceptedAt);
    assert.equal(received.length, 1, 'no duplicate reached the runtime');

    // Busy: a real run is in flight, so the next message waits in the real queue.
    state.block = new Promise<void>((resolve) => { release = resolve; });
    serverEnqueueMessage('joined-recipient', 'a long turn', {});
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(received.length, 2, 'the long turn is running');
    const busy = await runCli(plugin, ['send', '--to', 'joined-recipient', '--text', 'while you are busy', '--request-id', 'b'.repeat(64)], env);
    assert.equal(busy.json.state, 'accepted');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(received.length, 2, 'it did not jump into the running turn');
    assert.equal(chatRunRegistry.hasQueued('joined-recipient'), true, 'it is waiting in the real queue');
    release();
    state.block = undefined;
    for (let i = 0; i < 20 && received.length < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(received.length, 3, 'it ran at the completion boundary');
    assert.match(received[2].content, /while you are busy/);

    // No runtime: the real drain dequeues and drops. The answer must still claim
    // nothing — it says accepted, and delivery is unknown, which is exactly right.
    state.hasRuntime = false;
    const blind = await runCli(plugin, ['send', '--to', 'joined-recipient', '--text', 'into the dark', '--request-id', 'c'.repeat(64)], env);
    assert.equal(blind.json.state, 'accepted');
    assert.equal(blind.json.delivery, 'unknown');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(received.length, 3, 'nothing ran');
    assert.equal(chatRunRegistry.hasQueued('joined-recipient'), false, 'the real drain dropped it');
    state.hasRuntime = true;

    // Cross-project target and cross-domain capability, over the same live route.
    const far = await runCli(plugin, ['send', '--to', 'joined-elsewhere', '--text', 'hello', '--request-id', 'd'.repeat(64)], env);
    assert.equal(far.code, 4, 'a session in another project is not a peer');
    const operator = await fetch(`http://127.0.0.1:${port}/api/mission-control/peer/sessions/joined-sender/peers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-vibespace-peer-capability': plugin.missionControlSessionCapability(hmac, 'joined-sender') },
      body: '{}',
    });
    assert.equal(operator.status, 403, 'an operator capability is refused on the peer route');
    assert.equal(received.length, 3, 'no refusal path reached the runtime');
  });
});
