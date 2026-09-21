import assert from 'node:assert/strict';
import test from 'node:test';

import { sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry, MAX_QUEUED_MESSAGES } from '@/modules/websocket/services/chat-run-registry.service.js';
import {
  handleChatConnection,
  serverEnqueueMessage,
  serverEnqueueMessageChecked,
} from '@/modules/websocket/services/chat-websocket.service.js';

import {
  FakeSocket,
  legacyDatabaseFingerprint,
  PEER_MESSAGE,
  recordingRuntime,
  type RuntimeCall,
  withIsolatedDatabase,
} from './peer-message-fixture.js';

/**
 * What a plugin-enqueued peer message actually does to the transport.
 *
 * A host-module plugin queues cross-session peer messages through
 * `host.enqueueMessage`, which is this module's `serverEnqueueMessage`. The
 * plugin can observe nothing past that call, so the claims it makes about
 * delivery have to be proved here, against the real queue and the real drain:
 *
 *   1. a peer message reaches the recipient's provider runtime once, with its
 *      content byte-identical — including the sender identity the plugin frames
 *      into it;
 *   2. a recipient whose provider has no runtime **loses** the item — `drainQueue`
 *      dequeues before it checks `hasRuntime`, so the message is gone from the
 *      queue and was never run. Nothing may call that delivered;
 *   3. a busy recipient keeps the message queued and runs it at the completion
 *      boundary, not before.
 *
 * The runtime here is a recorder: it is the recipient, and every assertion is on
 * what it received rather than on the boolean `serverEnqueueMessage` returned.
 */
test('a peer message enqueued by a plugin reaches the recipient runtime once, unchanged', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('peer-recipient', 'claude', '/workspace/demo', 'Recipient');
    const received: RuntimeCall[] = [];
    const dependencies = recordingRuntime(received, { hasRuntime: true });
    handleChatConnection(new FakeSocket() as never, { user: { id: 1 } } as never, dependencies);

    const accepted = serverEnqueueMessage('peer-recipient', PEER_MESSAGE, {});
    assert.equal(accepted, true);
    // The drain is fired without awaiting inside serverEnqueueMessage.
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(received.length, 1, 'the recipient runtime ran it exactly once');
    assert.equal(received[0].content, PEER_MESSAGE, 'content is byte-identical');
    assert.match(received[0].content, /From: session claude-sender \(claude\)/);
    assert.equal(chatRunRegistry.hasQueued('peer-recipient'), false);
  });
});

test('serverEnqueueMessage returns true for a session that exists, which is not an acknowledgement', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('peer-dead', 'claude', '/workspace/demo', 'Dead');
    const received: RuntimeCall[] = [];
    // The provider has no runtime: the session row exists, nothing can run.
    const dependencies = recordingRuntime(received, { hasRuntime: false });
    handleChatConnection(new FakeSocket() as never, { user: { id: 1 } } as never, dependencies);

    assert.equal(serverEnqueueMessage('peer-dead', PEER_MESSAGE, {}), true,
      'true means only that getSessionById found a row');
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(received, [], 'nothing reached a runtime');
    // And the item is *gone*: drainQueue dequeues before checking hasRuntime.
    assert.equal(chatRunRegistry.hasQueued('peer-dead'), false,
      'the message was dropped, invisibly to whoever enqueued it');
  });
});

test('a busy recipient keeps the peer message queued and runs it at the completion boundary', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('peer-busy', 'claude', '/workspace/demo', 'Busy');
    const received: RuntimeCall[] = [];
    let release = () => {};
    const block = new Promise<void>((resolve) => { release = resolve; });
    const dependencies = recordingRuntime(received, { hasRuntime: true, block });
    const socket = new FakeSocket();
    handleChatConnection(socket as never, { user: { id: 1 } } as never, dependencies);

    // Occupy the session with a first turn that has not finished.
    serverEnqueueMessage('peer-busy', 'first turn', {});
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(received.length, 1, 'the first turn is running');

    serverEnqueueMessage('peer-busy', PEER_MESSAGE, {});
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(received.length, 1, 'the peer message did not jump into the running turn');
    assert.equal(chatRunRegistry.hasQueued('peer-busy'), true, 'it is queued, not delivered');

    release();
    // Let the first run settle and the completion handler drain the queue.
    for (let i = 0; i < 10 && received.length < 2; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(received.length, 2, 'the peer message ran after the first turn completed');
    assert.equal(received[1].content, PEER_MESSAGE);
  });
});


test('the isolated database neither copies from nor writes to the install directory database', async () => {
  const before = await legacyDatabaseFingerprint();
  await withIsolatedDatabase(async () => {
    // withIsolatedDatabase has already asserted the table starts empty; write
    // through the real connection so a mis-pointed path would show up below.
    sessionsDb.createSession('isolation-probe', 'claude', '/workspace/demo', 'Probe');
    assert.equal(sessionsDb.getAllSessions().length, 1);
  });
  assert.equal(await legacyDatabaseFingerprint(), before, 'database/auth.db is byte-for-byte untouched');
});

test('the checked enqueue refuses a recipient with no runtime and queues nothing the drain would drop', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('checked-dead', 'claude', '/workspace/demo', 'Dead');
    const received: RuntimeCall[] = [];
    const state = { hasRuntime: false };
    handleChatConnection(new FakeSocket() as never, { user: { id: 1 } } as never, recordingRuntime(received, state));

    assert.deepEqual(serverEnqueueMessageChecked('checked-missing', PEER_MESSAGE, {}), { outcome: 'missing' });
    assert.deepEqual(serverEnqueueMessageChecked('checked-dead', PEER_MESSAGE, {}), { outcome: 'runtime-unavailable' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(chatRunRegistry.hasQueued('checked-dead'), false, 'nothing was queued');
    assert.deepEqual(received, []);

    state.hasRuntime = true;
    assert.deepEqual(serverEnqueueMessageChecked('checked-dead', PEER_MESSAGE, {}), { outcome: 'accepted', recipientBusy: false });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(received.length, 1, 'accepted once the runtime is back, and it ran');
  });
});

test('the checked enqueue reports a busy recipient and refuses at the cap instead of evicting', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('checked-busy', 'claude', '/workspace/demo', 'Busy');
    const received: RuntimeCall[] = [];
    let release = () => {};
    const block = new Promise<void>((resolve) => { release = resolve; });
    handleChatConnection(new FakeSocket() as never, { user: { id: 1 } } as never, recordingRuntime(received, { hasRuntime: true, block }));

    serverEnqueueMessage('checked-busy', 'first turn', {});
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(received.length, 1, 'the first turn is running');

    for (let i = 0; i < MAX_QUEUED_MESSAGES; i += 1) {
      assert.deepEqual(serverEnqueueMessageChecked('checked-busy', `queued ${i}`, {}), { outcome: 'accepted', recipientBusy: true });
    }
    assert.deepEqual(serverEnqueueMessageChecked('checked-busy', 'one too many', {}), { outcome: 'queue-full' });
    const queued = chatRunRegistry.getQueueForClient('checked-busy').map((item) => item.content);
    assert.equal(queued.length, MAX_QUEUED_MESSAGES);
    assert.equal(queued[0], 'queued 0', 'the oldest accepted item was not evicted');
    assert.equal(queued.includes('one too many'), false);

    chatRunRegistry.clearQueue('checked-busy', 'aborted');
    release();
  });
});
