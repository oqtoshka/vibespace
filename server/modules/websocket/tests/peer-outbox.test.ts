import './peer-outbox-env.js';

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { closeConnection, getConnection, getDatabasePath, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import {
  admitPeerMessage,
  dispatchPeerOutbox,
  getPeerMessage,
  handleChatConnection,
  PEER_OUTBOX_MAX_PENDING,
  PEER_OUTBOX_MAX_PENDING_MS,
  serverAbortRun,
  serverEnqueueMessage,
  sweepPeerOutbox,
} from '@/modules/websocket/services/chat-websocket.service.js';
import type { PeerAdmissionInput } from '@/shared/types.js';

import { FakeSocket, legacyDatabaseFingerprint, recordingRuntime, type RuntimeCall, withIsolatedDatabase } from './peer-message-fixture.js';

/**
 * The durable peer outbox against the real database, the real run registry
 * and the real drain, with a recording runtime as the recipient.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function settle(done: () => boolean) {
  for (let i = 0; i < 40 && !done(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
}

function message(requestId: string, overrides: Partial<PeerAdmissionInput> = {}): PeerAdmissionInput {
  return {
    senderSessionId: 'sender',
    requestId,
    recipientSessionId: 'recipient',
    content: `peer message ${requestId}`,
    fingerprint: `fp-${requestId}`,
    ...overrides,
  };
}

/** Sender + recipient in one project, a connected recording runtime, and a
 * way to hold the recipient busy. */
function world() {
  sessionsDb.createSession('sender', 'claude', '/workspace/demo', 'Sender');
  sessionsDb.createSession('recipient', 'claude', '/workspace/demo', 'Recipient');
  const received: RuntimeCall[] = [];
  const state: { hasRuntime: boolean; block?: Promise<void> } = { hasRuntime: true };
  handleChatConnection(new FakeSocket() as never, { user: { id: 1 } } as never, recordingRuntime(received, state));
  let release = () => {};
  const busy = async (sessionId = 'recipient') => {
    state.block = new Promise<void>((resolve) => { release = () => { state.block = undefined; resolve(); }; });
    serverEnqueueMessage(sessionId, 'a long turn', {});
    await tick();
  };
  return { received, state, busy, release: () => release() };
}

/** Every run started in a test settles before its database closes, so no
 * completion handler fires against the next test's (or no) database. */
async function withDb(body: () => Promise<void>) {
  await withIsolatedDatabase(async () => {
    await body();
    await settle(() => !chatRunRegistry.isProcessing('recipient'));
    await tick();
    await tick();
  });
}

const status = (requestId: string) => getPeerMessage('sender', requestId)?.status;

test('accepted once; a replay with the same requestId reads the row and never dispatches twice', async () => {
  await withDb(async () => {
    const { received } = world();
    const first = admitPeerMessage(message('r1'));
    assert.equal(first.outcome, 'accepted');
    await tick();
    assert.equal(received.length, 1);
    assert.equal(status('r1'), 'dispatched');

    const replay = admitPeerMessage(message('r1'));
    assert.equal(replay.outcome, 'existing');
    assert.equal(replay.outcome === 'existing' && replay.record.acceptedAt,
      first.outcome === 'accepted' && first.record.acceptedAt);
    assert.equal(admitPeerMessage(message('r1', { content: 'other', fingerprint: 'fp-other' })).outcome, 'conflict');
    sweepPeerOutbox();
    await tick();
    assert.equal(received.length, 1, 'no second dispatch from replay or sweep');
  });
});

test('refusals persist nothing: no runtime, cap, cross-project, private or unknown sender', async () => {
  await withDb(async () => {
    const { received, state, busy, release } = world();
    sessionsDb.createSession('elsewhere', 'claude', '/workspace/other', 'Elsewhere');
    sessionsDb.createAppSession('hidden', 'claude', '/workspace/demo', false, true);

    state.hasRuntime = false;
    assert.equal(admitPeerMessage(message('n1')).outcome, 'runtime-unavailable');
    assert.equal(getPeerMessage('sender', 'n1'), null);
    state.hasRuntime = true;

    assert.equal(admitPeerMessage(message('x1', { recipientSessionId: 'elsewhere' })).outcome, 'ineligible');
    assert.equal(admitPeerMessage(message('x2', { recipientSessionId: 'hidden' })).outcome, 'ineligible');
    assert.equal(admitPeerMessage(message('x3', { senderSessionId: 'hidden' })).outcome, 'ineligible', 'a private sender speaks to nobody');
    assert.equal(admitPeerMessage(message('x4', { senderSessionId: 'nobody' })).outcome, 'missing');
    assert.equal(admitPeerMessage(message('x5', { recipientSessionId: 'nobody' })).outcome, 'missing');

    await busy();
    for (let i = 0; i < PEER_OUTBOX_MAX_PENDING; i += 1) {
      assert.equal(admitPeerMessage(message(`c${i}`)).outcome, 'accepted');
    }
    assert.equal(admitPeerMessage(message('over')).outcome, 'queue-full');
    assert.equal(getPeerMessage('sender', 'over'), null);
    assert.equal(received.length, 1, 'only the long turn ran');
    // Stop cancels, visibly: nothing stays "pending" that will never run.
    await serverAbortRun('recipient');
    release();
    assert.equal(status('c0'), 'cancelled');
    assert.equal(getPeerMessage('sender', 'c0')?.reason, 'recipient-aborted');
    await tick();
    assert.equal(received.length, 1, 'nothing ran after Stop');
  });
});

test('runtime loss after acceptance keeps the row pending, and restoration dispatches it once', async () => {
  await withDb(async () => {
    const { received, state, busy, release } = world();
    await busy();
    assert.equal(admitPeerMessage(message('p1')).outcome, 'accepted');
    assert.equal(status('p1'), 'pending', 'busy recipient: persisted, not dispatched');

    state.hasRuntime = false; // the runtime disappears before the drain
    release();
    await settle(() => !chatRunRegistry.isProcessing('recipient'));
    await tick();
    assert.equal(received.length, 1, 'nothing was handed to a missing runtime');
    assert.equal(status('p1'), 'pending', 'and nothing was dequeued or dropped');

    state.hasRuntime = true;
    sweepPeerOutbox();
    await settle(() => received.length === 2);
    assert.equal(received[1].content, 'peer message p1');
    assert.equal(status('p1'), 'dispatched');
    sweepPeerOutbox();
    await tick();
    assert.equal(received.length, 2);
  });
});

test('archive, privacy or project change after acceptance cancels with the reason, never dispatches', async () => {
  await withDb(async () => {
    const { received, busy, release } = world();
    sessionsDb.createSession('elsewhere', 'claude', '/workspace/other', 'Elsewhere');
    const db = getConnection();
    const cases: Array<[string, () => void, string]> = [
      ['a1', () => sessionsDb.updateSessionIsArchived('recipient', true), 'recipient-archived'],
      ['a2', () => db.prepare('UPDATE sessions SET is_private = 1 WHERE session_id = ?').run('recipient'), 'recipient-private'],
      ['a3', () => db.prepare('UPDATE sessions SET project_path = ? WHERE session_id = ?').run('/workspace/other', 'recipient'), 'recipient-left-project'],
    ];
    for (const [requestId, change, reason] of cases) {
      db.prepare("UPDATE sessions SET isArchived = 0, is_private = 0, project_path = '/workspace/demo' WHERE session_id = 'recipient'").run();
      await busy();
      const before = received.length;
      assert.equal(admitPeerMessage(message(requestId)).outcome, 'accepted');
      change();
      release();
      await settle(() => !chatRunRegistry.isProcessing('recipient'));
      await tick();
      assert.equal(status(requestId), 'cancelled');
      assert.equal(getPeerMessage('sender', requestId)?.reason, reason);
      assert.equal(received.length, before, `${reason}: not dispatched`);
    }
  });
});

test('a pending row older than the bound expires instead of being sent late', async () => {
  await withDb(async () => {
    world();
    chatRunRegistry.startQueuedRun('recipient'); // hold it busy without a runtime call
    assert.equal(admitPeerMessage(message('e1')).outcome, 'accepted');
    sweepPeerOutbox(Date.now() + PEER_OUTBOX_MAX_PENDING_MS + 1000);
    assert.equal(status('e1'), 'cancelled');
    assert.equal(getPeerMessage('sender', 'e1')?.reason, 'expired');
    chatRunRegistry.completeRun('recipient', { exitCode: 0 });
  });
});

test('restart: a fresh process dispatches pending rows and never replays a dispatched one (crash window)', async () => {
  const legacyBefore = await legacyDatabaseFingerprint();
  await withDb(async () => {
    const { received } = world();
    // d1 is dispatched and its turn never finishes — the process "crashes"
    // with the runtime holding it. p1 is accepted behind it and still pending.
    assert.equal(admitPeerMessage(message('d1')).outcome, 'accepted');
    await tick();
    assert.equal(status('d1'), 'dispatched');
    chatRunRegistry.startQueuedRun('recipient');
    assert.equal(admitPeerMessage(message('p1')).outcome, 'accepted');
    assert.equal(status('p1'), 'pending');
    assert.equal(received.length, 1);

    // Copy the database file as the crashed process left it, then boot a new
    // process on it: empty memory, same rows.
    closeConnection();
    const crashDir = mkdtempSync(path.join(tmpdir(), 'peer-outbox-crash-'));
    const crashDb = path.join(crashDir, 'auth.db');
    copyFileSync(getDatabasePath(), crashDb);
    const child = spawnSync(process.execPath, [
      path.join(here, '../../../../node_modules/tsx/dist/cli.mjs'),
      '--tsconfig', path.join(here, '../../../tsconfig.json'),
      path.join(here, 'peer-outbox-restart-child.ts'),
    ], {
      env: { ...process.env, DATABASE_PATH: crashDb, PEER_OUTBOX_KEEP_DATABASE_PATH: '1' },
      encoding: 'utf8',
      timeout: 60_000,
    });
    assert.equal(child.status, 0, child.stderr);
    const line = child.stdout.trim().split('\n').at(-1) ?? '{}';
    const result = JSON.parse(line) as { received: string[]; rows: Array<{ request_id: string; status: string }> };
    assert.deepEqual(result.received, ['peer message p1'], 'only the pending row ran after the restart');
    assert.deepEqual(result.rows.map((row) => [row.request_id, row.status]), [['d1', 'dispatched'], ['p1', 'dispatched']],
      'd1 stays dispatched (fate unknown), never replayed');
    chatRunRegistry.completeRun('recipient', { exitCode: 0 });
  });
  assert.equal(await legacyDatabaseFingerprint(), legacyBefore, 'database/auth.db untouched');
});

test('dispatchPeerOutbox waits for the ordinary queue and an idle recipient', async () => {
  await withDb(async () => {
    const { received, busy, release } = world();
    await busy();
    assert.equal(admitPeerMessage(message('q1')).outcome, 'accepted');
    serverEnqueueMessage('recipient', 'operator follow-up', {});
    dispatchPeerOutbox('recipient');
    assert.equal(status('q1'), 'pending');
    release();
    await settle(() => received.length >= 3);
    await settle(() => status('q1') === 'dispatched' && received.length === 3);
    assert.deepEqual(received.slice(1).map((call) => call.content), ['operator follow-up', 'peer message q1'],
      'the ordinary queue goes first');
  });
});
