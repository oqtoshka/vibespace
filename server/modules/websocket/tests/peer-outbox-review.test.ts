import './peer-outbox-env.js';

import assert from 'node:assert/strict';
import test from 'node:test';

import { getConnection, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import {
  admitPeerMessage,
  dispatchPeerOutbox,
  getPeerMessage,
  handleChatConnection,
  PEER_OUTBOX_MAX_PENDING_MS,
  serverAbortRun,
  serverEnqueueMessage,
} from '@/modules/websocket/services/chat-websocket.service.js';
import type { PeerAdmissionInput } from '@/shared/types.js';

import { FakeSocket, withIsolatedDatabase } from './peer-message-fixture.js';

/**
 * Review gaps in the durable peer outbox, each reproduced through the real
 * abort paths, the real run registry and the real dispatcher. The runtime is
 * scripted per test: it records each turn and lets the test decide when (and
 * whether) the turn emits its own `complete` and when its promise settles.
 */
type Writer = { sendComplete: (opts: { exitCode: number; aborted?: boolean }) => void };
type Turn = { content: string; writer: Writer; settle: () => void };

function scriptedRuntime(opts: { hasRuntime?: boolean; onAbort?: (turn: Turn | undefined) => Promise<void> } = {}) {
  const turns: Turn[] = [];
  const state = { hasRuntime: opts.hasRuntime ?? true };
  const dependencies = {
    runtime: {
      hasRuntime: () => state.hasRuntime,
      run: (_provider: string, content: string, _options: unknown, writer: Writer) => new Promise<void>((resolve) => {
        turns.push({ content, writer, settle: resolve });
      }),
      abort: async () => { await opts.onAbort?.(turns.at(-1)); return true; },
      resolveToolApproval: () => {},
      getPendingApprovalsForSession: () => [],
    },
  } as unknown as Parameters<typeof handleChatConnection>[2];
  const socket = new FakeSocket();
  handleChatConnection(socket as never, { user: { id: 1 } } as never, dependencies);
  return { turns, state, socket };
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
async function settle(done: () => boolean) {
  for (let i = 0; i < 60 && !done(); i += 1) await tick(5);
}

function people() {
  sessionsDb.createSession('sender', 'claude', '/workspace/demo', 'Sender');
  sessionsDb.createSession('recipient', 'claude', '/workspace/demo', 'Recipient');
  sessionsDb.createSession('elsewhere', 'claude', '/workspace/other', 'Elsewhere');
}

function message(requestId: string, overrides: Partial<PeerAdmissionInput> = {}): PeerAdmissionInput {
  return { senderSessionId: 'sender', requestId, recipientSessionId: 'recipient', content: `peer ${requestId}`, fingerprint: `fp-${requestId}`, ...overrides };
}

const row = (requestId: string) => getPeerMessage('sender', requestId);

/** Tear down whatever a test left running so the next one starts idle. */
async function quiesce(turns: Turn[]) {
  for (const turn of turns) turn.settle();
  chatRunRegistry.completeRun('recipient', { exitCode: 0 });
  await settle(() => !chatRunRegistry.isProcessing('recipient'));
  await tick(5);
  chatRunRegistry.clearAll();
}

/** A pending row on an idle recipient: accepted while busy, then the runtime
 * went away before the turn ended — exactly the state a restart also leaves. */
async function pendingOnIdleRecipient() {
  const rt = scriptedRuntime();
  serverEnqueueMessage('recipient', 'a long turn', {});
  await tick();
  assert.equal(admitPeerMessage(message('p1')).outcome, 'accepted');
  assert.equal(row('p1')?.status, 'pending');
  rt.state.hasRuntime = false;
  rt.turns[0].writer.sendComplete({ exitCode: 0 });
  rt.turns[0].settle();
  await settle(() => !chatRunRegistry.isProcessing('recipient'));
  await tick(5);
  assert.equal(row('p1')?.status, 'pending', 'precondition: pending with an idle recipient');
  return rt;
}

test('gap 1: Stop over chat.abort with no running turn still cancels the pending peer rows', async () => {
  await withIsolatedDatabase(async () => {
    chatRunRegistry.clearAll();
    people();
    const rt = await pendingOnIdleRecipient();
    rt.socket.emit('message', Buffer.from(JSON.stringify({ type: 'chat.abort', sessionId: 'recipient' })));
    await tick(5);
    assert.ok(rt.socket.sent.some((m) => (m as { code?: string }).code === 'NO_ACTIVE_RUN' || JSON.stringify(m).includes('NO_ACTIVE_RUN')),
      'the existing NO_ACTIVE_RUN answer is preserved');
    assert.equal(row('p1')?.status, 'cancelled');
    assert.equal(row('p1')?.reason, 'recipient-aborted');
    rt.state.hasRuntime = true;
    dispatchPeerOutbox('recipient');
    assert.equal(rt.turns.length, 1, 'no surprise dispatch after Stop');
    await quiesce(rt.turns);
  });
});

test('gap 1: serverAbortRun with no running turn still cancels the pending peer rows and returns false', async () => {
  await withIsolatedDatabase(async () => {
    chatRunRegistry.clearAll();
    people();
    const rt = await pendingOnIdleRecipient();
    assert.equal(await serverAbortRun('recipient'), false, 'return semantics unchanged: nothing was running');
    assert.equal(row('p1')?.status, 'cancelled');
    assert.equal(row('p1')?.reason, 'recipient-aborted');
    await quiesce(rt.turns);
  });
});

test('gap 2: an expired pending row is cancelled at dispatch, not sent, on admission and on completion', async () => {
  await withIsolatedDatabase(async () => {
    chatRunRegistry.clearAll();
    people();
    const rt = scriptedRuntime();
    serverEnqueueMessage('recipient', 'a long turn', {});
    await tick();
    assert.equal(admitPeerMessage(message('old1')).outcome, 'accepted');
    assert.equal(admitPeerMessage(message('old2')).outcome, 'accepted');
    // Age both rows past the bound (exactly the bound for old1: age >= max expires).
    const db = getConnection();
    db.prepare("UPDATE peer_outbox SET accepted_at = ? WHERE request_id = 'old1'")
      .run(new Date(Date.now() - PEER_OUTBOX_MAX_PENDING_MS).toISOString());
    db.prepare("UPDATE peer_outbox SET accepted_at = ? WHERE request_id = 'old2'")
      .run(new Date(Date.now() - PEER_OUTBOX_MAX_PENDING_MS - 60_000).toISOString());

    // Completion path: the long turn ends; the handler dispatches directly.
    rt.turns[0].writer.sendComplete({ exitCode: 0 });
    rt.turns[0].settle();
    await settle(() => row('old1')?.status !== 'pending' && row('old2')?.status !== 'pending');
    await tick(5);
    assert.equal(row('old1')?.status, 'cancelled');
    assert.equal(row('old1')?.reason, 'expired');
    assert.equal(row('old2')?.reason, 'expired');
    assert.equal(rt.turns.length, 1, 'no expired row reached the runtime');

    // Admission path: a fresh row is sent; a stale one queued before it is not.
    serverEnqueueMessage('recipient', 'another long turn', {});
    await tick();
    assert.equal(admitPeerMessage(message('old3')).outcome, 'accepted');
    db.prepare("UPDATE peer_outbox SET accepted_at = ? WHERE request_id = 'old3'")
      .run(new Date(Date.now() - PEER_OUTBOX_MAX_PENDING_MS - 1).toISOString());
    rt.turns[1].writer.sendComplete({ exitCode: 0 });
    rt.turns[1].settle();
    // Hold the completion handler off the row: a direct admission must expire it itself.
    assert.equal(admitPeerMessage(message('fresh')).outcome, 'accepted');
    await settle(() => row('fresh')?.status === 'dispatched');
    assert.equal(row('old3')?.reason, 'expired');
    assert.deepEqual(rt.turns.map((t) => t.content).slice(2), ['peer fresh'], 'only the fresh row ran');
    await quiesce(rt.turns);
  });
});

test('gap 3: a turn that emits its own complete cannot, when its promise settles later, end the next turn', async () => {
  await withIsolatedDatabase(async () => {
    chatRunRegistry.clearAll();
    people();
    const rt = scriptedRuntime();
    serverEnqueueMessage('recipient', 'first', {});
    await tick();
    serverEnqueueMessage('recipient', 'second', {});
    assert.equal(admitPeerMessage(message('peer-third')).outcome, 'accepted');
    assert.equal(rt.turns.length, 1);

    // The runtime reports completion itself; the drain starts "second".
    rt.turns[0].writer.sendComplete({ exitCode: 0 });
    await settle(() => rt.turns.length === 2);
    assert.equal(rt.turns[1].content, 'second');
    const secondRun = chatRunRegistry.getRun('recipient');
    assert.equal(secondRun?.status, 'running');

    // Only now does the first turn's promise settle.
    rt.turns[0].settle();
    await tick(10);
    assert.equal(chatRunRegistry.getRun('recipient'), secondRun, 'the second run is still the current run');
    assert.equal(secondRun?.status, 'running', 'the stale finally did not complete the newer run');
    assert.equal(rt.turns.length, 2, 'the peer message did not start alongside "second"');
    assert.equal(row('peer-third')?.status, 'pending');

    rt.turns[1].writer.sendComplete({ exitCode: 0 });
    rt.turns[1].settle();
    await settle(() => rt.turns.length === 3);
    assert.equal(rt.turns[2].content, 'peer peer-third', 'serialised: peer after both ordinary turns');
    await quiesce(rt.turns);
  });
});

for (const path of ['chat.abort', 'serverAbortRun'] as const) {
  test(`gap 4: a completion emitted while ${path} awaits runtime.abort cannot launch a waiting peer`, async () => {
    await withIsolatedDatabase(async () => {
      chatRunRegistry.clearAll();
      people();
      const rt = scriptedRuntime({
        onAbort: async (turn) => {
          // The runtime reports the aborted turn complete, then keeps the abort
          // pending long enough for the registry's completion handler to run.
          turn?.writer.sendComplete({ exitCode: 1, aborted: true });
          await tick(20);
        },
      });
      serverEnqueueMessage('recipient', 'running turn', {});
      await tick();
      assert.equal(admitPeerMessage(message('waiting')).outcome, 'accepted');
      if (path === 'chat.abort') {
        rt.socket.emit('message', Buffer.from(JSON.stringify({ type: 'chat.abort', sessionId: 'recipient' })));
      } else {
        void serverAbortRun('recipient');
      }
      // An admission that races the in-flight Stop must not run either.
      await tick(2);
      admitPeerMessage(message('during-stop'));
      await tick(40);
      assert.equal(rt.turns.length, 1, 'Stop launched nothing');
      assert.equal(row('waiting')?.status, 'cancelled');
      assert.equal(row('waiting')?.reason, 'recipient-aborted');
      assert.notEqual(row('during-stop')?.status, 'dispatched');
      await quiesce(rt.turns);
    });
  });
}

test('gap 5: a pending row whose sender became private, archived, moved project or was deleted is cancelled, never sent', async () => {
  await withIsolatedDatabase(async () => {
    chatRunRegistry.clearAll();
    people();
    const rt = scriptedRuntime();
    const db = getConnection();
    const cases: Array<[string, () => void, string]> = [
      ['s1', () => db.prepare('UPDATE sessions SET is_private = 1 WHERE session_id = ?').run('sender'), 'sender-private'],
      ['s2', () => sessionsDb.updateSessionIsArchived('sender', true), 'sender-archived'],
      ['s3', () => db.prepare("UPDATE sessions SET project_path = '/workspace/other' WHERE session_id = ?").run('sender'), 'sender-left-project'],
      ['s4', () => db.prepare('DELETE FROM sessions WHERE session_id = ?').run('sender'), 'sender-missing'],
    ];
    for (const [requestId, change, reason] of cases) {
      if (!sessionsDb.getSessionById('sender')) sessionsDb.createSession('sender', 'claude', '/workspace/demo', 'Sender');
      db.prepare("UPDATE sessions SET isArchived = 0, is_private = 0, project_path = '/workspace/demo' WHERE session_id = 'sender'").run();
      const before = rt.turns.length;
      serverEnqueueMessage('recipient', `hold ${requestId}`, {});
      await settle(() => rt.turns.length === before + 1);
      assert.equal(admitPeerMessage(message(requestId)).outcome, 'accepted');
      change();
      rt.turns.at(-1)!.writer.sendComplete({ exitCode: 0 });
      rt.turns.at(-1)!.settle();
      await settle(() => !chatRunRegistry.isProcessing('recipient'));
      await tick(5);
      assert.equal(row(requestId)?.status, 'cancelled', `${reason}: cancelled`);
      assert.equal(row(requestId)?.reason, reason);
      assert.equal(rt.turns.length, before + 1, `${reason}: never dispatched`);
    }
    // A historical dispatched row is not rewritten by a later sender change.
    db.prepare("UPDATE sessions SET isArchived = 0, is_private = 0, project_path = '/workspace/demo' WHERE session_id = 'sender'").run();
    if (!sessionsDb.getSessionById('sender')) sessionsDb.createSession('sender', 'claude', '/workspace/demo', 'Sender');
    assert.equal(admitPeerMessage(message('hist')).outcome, 'accepted');
    await settle(() => row('hist')?.status === 'dispatched');
    db.prepare('UPDATE sessions SET is_private = 1 WHERE session_id = ?').run('sender');
    dispatchPeerOutbox('recipient');
    assert.equal(row('hist')?.status, 'dispatched');
    await quiesce(rt.turns);
  });
});
