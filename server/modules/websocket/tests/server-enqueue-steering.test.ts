import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import {
  registerChatDependenciesAtBoot,
  serverEnqueueMessage,
} from '@/modules/websocket/services/chat-websocket.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

/**
 * The regression these cover: an operator answers a question in Mission
 * Control's Overview while the agent is working. The answer used to sit in the
 * server-owned queue until the whole turn ended — sometimes hours — because the
 * server-initiated send never tried the mid-turn path the browser composer
 * takes. It has to behave like an ordinary user message: delivered now.
 */

/** Collects the frames the gateway writer forwards; OPEN so `sendJson` lets them through. */
class FakeConnection {
  readyState = 1;
  frames: Array<Record<string, unknown>> = [];

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }
}

type Injection = { providerSessionId: string; content: string; options: Record<string, unknown> };

type Harness = {
  injections: Injection[];
  /** Content of every turn the server started from the queue. */
  drainedRuns: string[];
  /** What the next injection resolves to: a uuid accepts it, null declines it. */
  injectResult: string | null;
  /** Resolves the in-flight injection when set (to exercise the await window). */
  release?: () => void;
};

function registerHarness(harness: Harness): void {
  registerChatDependenciesAtBoot({
    runtime: {
      hasRuntime: () => true,
      run: async (_provider: string, content: string) => {
        harness.drainedRuns.push(content);
      },
      abort: async () => true,
      resolveToolApproval: () => {},
      getPendingApprovalsForSession: () => [],
    },
    injectFns: {
      codex: async (
        providerSessionId: string,
        content: string,
        options: Record<string, unknown>,
      ) => {
        harness.injections.push({ providerSessionId, content, options });
        if (harness.release) {
          await new Promise<void>((resolve) => { harness.release = resolve; });
        }
        if (harness.injectResult) {
          (options.onDelivered as (() => void) | undefined)?.();
        }
        return harness.injectResult;
      },
    },
  } as never);
}

async function withIsolatedDatabase(runTest: (harness: Harness) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'server-enqueue-steering-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  const harness: Harness = { injections: [], drainedRuns: [], injectResult: 'injected-uuid-1' };
  registerHarness(harness);

  try {
    await runTest(harness);
  } finally {
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** A session with a live turn, the state an operator answers a card in. */
function startWorkingSession(sessionId: string): void {
  sessionsDb.createSession(sessionId, 'codex', '/workspace/demo', 'Security');
  // The live run carries the provider session id the injection addresses.
  const run = chatRunRegistry.startRun({
    appSessionId: sessionId,
    provider: 'codex',
    providerSessionId: `provider-${sessionId}`,
    connection: new FakeConnection() as never,
    userId: 1,
  });
  assert.ok(run, 'the session must be mid-turn for these cases');
  assert.equal(chatRunRegistry.isProcessing(sessionId), true);
}

/** Lets the injection promise and the registry callbacks settle. */
const settle = async (): Promise<void> => { await new Promise((resolve) => setImmediate(resolve)); };

/**
 * Waits for a condition the drain reaches after several awaits, then settles
 * once more so a wrong extra send would still be recorded before we assert.
 */
async function waitFor(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await settle();
  assert.ok(condition(), `timed out waiting for ${what}`);
}

test('a decision answer reaches a working session as a mid-turn steer, not a queued turn', async () => {
  await withIsolatedDatabase(async (harness) => {
    startWorkingSession('session-working');

    const accepted = serverEnqueueMessage(
      'session-working',
      'Decisions from Mission Control\n\nAnswer:\nЛулу окна нет',
      { permissionMode: 'bypassPermissions' },
      { userId: 1, deliverMidTurn: true },
    );

    assert.equal(accepted, true, 'the caller is told VibeSpace owns the message straight away');
    await settle();

    assert.equal(harness.injections.length, 1, 'the running turn is steered');
    assert.equal(harness.injections[0]?.providerSessionId, 'provider-session-working');
    assert.match(harness.injections[0]?.content ?? '', /Лулу окна нет/);
    assert.equal(
      harness.drainedRuns.length, 0,
      'and nothing waits for the turn to end',
    );
    assert.deepEqual(
      chatRunRegistry.getQueueForClient('session-working'), [],
      'the delivered message is no longer pending for any client',
    );
  });
});

test('a steered answer is not sent a second time when the turn completes', async () => {
  await withIsolatedDatabase(async (harness) => {
    startWorkingSession('session-once');

    serverEnqueueMessage('session-once', 'answer once', {}, { deliverMidTurn: true });
    await settle();
    assert.equal(harness.injections.length, 1);

    // The turn ends: the registry fires its drain for whatever is still queued.
    chatRunRegistry.completeRun('session-once', { exitCode: 0 });
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(harness.drainedRuns.length, 0, 'the drain must not resend a steered message');
    assert.equal(harness.injections.length, 1, 'and it is injected exactly once');
  });
});

test('an answer the runtime declines mid-turn still runs when the turn ends', async () => {
  await withIsolatedDatabase(async (harness) => {
    startWorkingSession('session-declined');
    harness.injectResult = null;

    serverEnqueueMessage('session-declined', 'answer fallback', {}, { deliverMidTurn: true });
    await settle();

    assert.equal(harness.injections.length, 1, 'delivery was attempted');
    assert.equal(harness.drainedRuns.length, 0, 'but nothing runs while the turn is live');
    assert.equal(
      chatRunRegistry.getQueueForClient('session-declined').length, 1,
      'the operator sees it still pending',
    );

    chatRunRegistry.completeRun('session-declined', { exitCode: 0 });
    await waitFor(() => harness.drainedRuns.length > 0, 'the queued answer to run');

    assert.deepEqual(harness.drainedRuns, ['answer fallback'], 'the queue remains responsible for it');
  });
});

test('a turn that ends while the injection is in flight still starts the declined message', async () => {
  await withIsolatedDatabase(async (harness) => {
    startWorkingSession('session-race');
    harness.injectResult = null;
    harness.release = () => {};

    serverEnqueueMessage('session-race', 'answer racing', {}, { deliverMidTurn: true });
    await settle();
    assert.equal(harness.injections.length, 1, 'the injection is in flight');

    // The turn finishes before the runtime answers, so the registry's own drain
    // runs against a queue whose item is still owned by the injection attempt.
    chatRunRegistry.completeRun('session-race', { exitCode: 0 });
    await settle();
    const releaseInjection = harness.release as () => void;
    harness.release = undefined;
    releaseInjection();
    await waitFor(() => harness.drainedRuns.length > 0, 'the declined answer to run');

    assert.deepEqual(
      harness.drainedRuns, ['answer racing'],
      'the post-await re-check starts it rather than leaving it queued forever',
    );
  });
});

test('without the flag a server message keeps turn-start semantics', async () => {
  await withIsolatedDatabase(async (harness) => {
    startWorkingSession('session-restore');

    // Boot restore and the usage-limit wake mean "run this as its own turn";
    // folding them into someone else's running turn would lose the turn.
    serverEnqueueMessage('session-restore', '[session supervisor] continue', {}, { userId: 1 });
    await settle();

    assert.equal(harness.injections.length, 0, 'no steer is attempted');
    assert.equal(harness.drainedRuns.length, 0, 'and it waits for the running turn');

    chatRunRegistry.completeRun('session-restore', { exitCode: 0 });
    await waitFor(() => harness.drainedRuns.length > 0, 'the queued turn to start');

    assert.deepEqual(harness.drainedRuns, ['[session supervisor] continue']);
  });
});

test('an idle session runs the answer immediately, flag or not', async () => {
  await withIsolatedDatabase(async (harness) => {
    sessionsDb.createSession('session-idle', 'codex', '/workspace/demo', 'Idle');

    serverEnqueueMessage('session-idle', 'answer idle', {}, { deliverMidTurn: true });
    await waitFor(() => harness.drainedRuns.length > 0, 'the answer to run at once');

    assert.equal(harness.injections.length, 0, 'there is no turn to steer');
    assert.deepEqual(harness.drainedRuns, ['answer idle']);
  });
});

test('a vanished session is refused so the caller records no receipt', async () => {
  await withIsolatedDatabase(async (harness) => {
    assert.equal(
      serverEnqueueMessage('session-gone', 'answer', {}, { deliverMidTurn: true }),
      false,
    );
    await settle();
    assert.equal(harness.injections.length, 0);
    assert.equal(harness.drainedRuns.length, 0);
  });
});
