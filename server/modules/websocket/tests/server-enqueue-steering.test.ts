import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import {
  handleChatConnection,
  pluginHostEnqueueMessage,
  registerChatDependenciesAtBoot,
  serverAbortRun,
  serverEnqueueMessage,
  setMidTurnDeliveryDeadlineForTests,
} from '@/modules/websocket/services/chat-websocket.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

/**
 * The regression these cover: an operator answers a question in Mission
 * Control's Overview while the agent is working. The answer used to sit in the
 * server-owned queue until the whole turn ended — sometimes hours — because the
 * server-initiated send never tried the mid-turn path the browser composer
 * takes. It has to behave like an ordinary user message: delivered now.
 *
 * The second half of the contract is what happens when that delivery and the
 * end of the turn collide. One message must reach the agent once: never twice
 * (the same instruction executed again is not undoable), and never silently
 * dropped. Where the runtime gives no answer at all, the server says so
 * instead of guessing — see `deliveryUnresolved`.
 */

/** Collects the frames the gateway writer forwards; OPEN so `sendJson` lets them through. */
class FakeConnection {
  readyState = 1;
  frames: Array<Record<string, unknown>> = [];

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }
}

/** A client socket, for the composer paths that only exist behind `chat.*` frames. */
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

/**
 * How a scripted runtime answers one injection:
 * - `accept` — takes the message (optionally reporting `onDelivered` first, the
 *   way Codex's `turn/steer` does, before its own acknowledgement).
 * - `decline` — answers "no id": a definite refusal, nothing was sent.
 * - `throw` — fails after the request left: nobody knows whether it landed.
 * - `hold` — never answers at all (a wedged provider socket).
 */
type InjectionScript =
  | { kind: 'accept'; uuid?: string; reportDelivered?: boolean }
  | { kind: 'decline' }
  | { kind: 'throw'; message?: string }
  | { kind: 'hold' };

/** One injection the service asked for, settled by the test when it chooses. */
type Attempt = {
  providerSessionId: string;
  content: string;
  options: Record<string, unknown>;
  /** Answers this attempt. Calling it twice is a no-op (a promise settles once). */
  settle: (script: InjectionScript) => void;
};

type Harness = {
  attempts: Attempt[];
  /** Content of every turn the server started from the queue. */
  drainedRuns: string[];
  /** Applied to each attempt as it arrives; leave unset to settle by hand. */
  autoSettle?: InjectionScript;
};

/**
 * The dependency object both entry points share, so a composer frame and a
 * server-initiated send are provably taking the same delivery path.
 */
function buildDependencies(harness: Harness): unknown {
  return {
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
      claude: (...args: [string, string, Record<string, unknown>]) => inject(...args),
      codex: (...args: [string, string, Record<string, unknown>]) => inject(...args),
    },
  };

  function inject(
    providerSessionId: string,
    content: string,
    options: Record<string, unknown>,
  ): Promise<string | null> {
    return new Promise<string | null>((resolve, reject) => {
        const attempt: Attempt = {
          providerSessionId,
          content,
          options,
          settle: (script: InjectionScript) => {
            switch (script.kind) {
              case 'accept':
                if (script.reportDelivered !== false) {
                  (options.onDelivered as (() => void) | undefined)?.();
                }
                resolve(script.uuid ?? `injected-${harness.attempts.length}`);
                return;
              case 'decline':
                resolve(null);
                return;
              case 'throw':
                reject(new Error(script.message ?? 'provider socket died mid-steer'));
                return;
              case 'hold':
            }
          },
        };
        harness.attempts.push(attempt);
        if (harness.autoSettle) {
          attempt.settle(harness.autoSettle);
        }
    });
  }
}

/**
 * Runs one case against a database of its own.
 *
 * The file is created empty first on purpose: `initializeDatabase` otherwise
 * copies the checkout's `database/auth.db` into the target as a legacy
 * migration, which would pull real local data into a test. Nothing here reads
 * the user's `.env` either — `DATABASE_PATH` is set explicitly and restored.
 */
async function withIsolatedDatabase(runTest: (harness: Harness) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'server-enqueue-steering-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  await writeFile(databasePath, '');
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  const harness: Harness = { attempts: [], drainedRuns: [] };
  chatDependencies = buildDependencies(harness);
  registerChatDependenciesAtBoot(chatDependencies as never);

  try {
    await runTest(harness);
  } finally {
    setMidTurnDeliveryDeadlineForTests(null);
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
function startWorkingSession(sessionId: string, provider: 'codex' | 'claude' = 'codex'): void {
  sessionsDb.createSession(sessionId, provider, '/workspace/demo', 'Security');
  // The live run carries the provider session id the injection addresses.
  const run = chatRunRegistry.startRun({
    appSessionId: sessionId,
    provider,
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
 * Gives every queued continuation — including a drain that must NOT happen —
 * a real chance to run before an assertion of absence. `drainQueue` reaches its
 * `dequeueNext` without awaiting anything, so a wrong drain is always recorded
 * within these ticks.
 */
async function letPendingWorkRun(): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

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

/** The queue as every client sees it. */
function queueOf(sessionId: string): ReturnType<typeof chatRunRegistry.getQueueForClient> {
  return chatRunRegistry.getQueueForClient(sessionId);
}

/** Drives one `chat.*` frame through the connection handler and waits for it. */
async function sendFrame(socket: FakeSocket, frame: Record<string, unknown>): Promise<void> {
  const listeners = socket.listeners('message') as Array<(raw: unknown) => unknown>;
  for (const listener of listeners) {
    await listener(Buffer.from(JSON.stringify(frame)));
  }
}

/** The dependencies registered for the case currently running. */
let chatDependencies: unknown = null;

/** A connected browser, for the paths that only exist behind `chat.*` frames. */
function connect(): FakeSocket {
  const socket = new FakeSocket();
  handleChatConnection(socket as never, { user: { id: 1 } } as never, chatDependencies as never);
  connectedClients.add(socket as never);
  return socket;
}

// ---------------------------------------------------------------------------
// Delivering an operator's answer into a running turn
// ---------------------------------------------------------------------------

test('a decision answer reaches a working session as a mid-turn steer, not a queued turn', async () => {
  await withIsolatedDatabase(async (harness) => {
    startWorkingSession('session-working');
    harness.autoSettle = { kind: 'accept' };

    const accepted = serverEnqueueMessage(
      'session-working',
      'Decisions from Mission Control\n\nAnswer:\nЛулу окна нет',
      { permissionMode: 'bypassPermissions' },
      { userId: 1, deliverMidTurn: true },
    );

    assert.equal(accepted, true, 'the caller is told VibeSpace owns the message straight away');
    await settle();

    assert.equal(harness.attempts.length, 1, 'the running turn is steered');
    assert.equal(harness.attempts[0]?.providerSessionId, 'provider-session-working');
    assert.match(harness.attempts[0]?.content ?? '', /Лулу окна нет/);
    assert.equal(harness.drainedRuns.length, 0, 'and nothing waits for the turn to end');
    assert.deepEqual(
      queueOf('session-working'), [],
      'the delivered message is no longer pending for any client',
    );
  });
});

/**
 * The failure the operator hit on 1.38.75, reproduced end to end from the
 * plugin's side: the Mission Control decision route calls the host's
 * `enqueueMessage(sessionId, message, { deliverMidTurn: true, permissionMode })`
 * against a Claude session in a long turn. A host that dropped the flag queued
 * the answer for the drain, so it reached the agent only when the turn ended —
 * sixteen minutes later in the live session — while typed messages sent in the
 * same window were steered in at once.
 */
test('an answer through the plugin host steers a working Claude turn, like a typed message', async () => {
  await withIsolatedDatabase(async (harness) => {
    startWorkingSession('session-claude-card', 'claude');
    harness.autoSettle = { kind: 'accept' };

    const accepted = pluginHostEnqueueMessage(
      'session-claude-card',
      'Decisions from Mission Control\n\n1. Release now?\nAnswer: yes',
      { deliverMidTurn: true, permissionMode: 'bypassPermissions' },
    );
    assert.equal(accepted, true);
    await settle();

    assert.equal(harness.attempts.length, 1, 'the running turn is steered, not queued behind');
    assert.equal(harness.attempts[0]?.providerSessionId, 'provider-session-claude-card');
    assert.equal(harness.attempts[0]?.options.permissionMode, 'bypassPermissions', 'the session keeps its mode');
    assert.equal('deliverMidTurn' in (harness.attempts[0]?.options ?? {}), false, 'the delivery flag never reaches the runtime');
    assert.deepEqual(queueOf('session-claude-card'), [], 'nothing is left waiting for the turn to end');

    chatRunRegistry.completeRun('session-claude-card', { exitCode: 0 });
    await letPendingWorkRun();
    assert.deepEqual(harness.drainedRuns, [], 'and the end of the turn does not send it again');
  });
});

test('a card answer and a typed message take the same path into a running turn', async () => {
  await withIsolatedDatabase(async (harness) => {
    startWorkingSession('session-parity', 'claude');
    harness.autoSettle = { kind: 'accept' };
    const socket = connect();

    await sendFrame(socket, {
      type: 'chat.queue-add',
      sessionId: 'session-parity',
      id: 'typed-1',
      content: 'typed while it works',
      options: { permissionMode: 'bypassPermissions' },
    });
    pluginHostEnqueueMessage('session-parity', 'answered on the card', {
      deliverMidTurn: true,
      permissionMode: 'bypassPermissions',
    });
    await letPendingWorkRun();

    assert.deepEqual(
      harness.attempts.map((attempt) => attempt.content),
      ['typed while it works', 'answered on the card'],
      'both are steered into the turn',
    );
    assert.deepEqual(queueOf('session-parity'), [], 'neither waits in the queue');
    assert.deepEqual(harness.drainedRuns, []);
  });
});

test('a plugin prompt without the flag still waits for the turn (a queued task, a resume)', async () => {
  await withIsolatedDatabase(async (harness) => {
    startWorkingSession('session-plugin-task', 'claude');

    pluginHostEnqueueMessage('session-plugin-task', 'start the queued task', { permissionMode: 'default' });
    // A truthy non-boolean is not the flag.
    pluginHostEnqueueMessage('session-plugin-task', 'still a turn of its own', { deliverMidTurn: 'yes' });
    await letPendingWorkRun();

    assert.equal(harness.attempts.length, 0, 'no steer is attempted');
    assert.equal(queueOf('session-plugin-task').length, 2, 'both wait for the running turn');
  });
});

test('a steered answer is not sent a second time when the turn completes', async () => {
  await withIsolatedDatabase(async (harness) => {
    startWorkingSession('session-once');
    harness.autoSettle = { kind: 'accept' };

    serverEnqueueMessage('session-once', 'answer once', {}, { deliverMidTurn: true });
    await settle();
    assert.equal(harness.attempts.length, 1);

    // The turn ends: the registry fires its drain for whatever is still queued.
    chatRunRegistry.completeRun('session-once', { exitCode: 0 });
    await letPendingWorkRun();

    assert.deepEqual(harness.drainedRuns, [], 'the drain must not resend a steered message');
    assert.equal(harness.attempts.length, 1, 'and it is injected exactly once');
  });
});

test('without the flag a server message keeps turn-start semantics', async () => {
  await withIsolatedDatabase(async (harness) => {
    startWorkingSession('session-restore');

    // Boot restore and the usage-limit wake mean "run this as its own turn";
    // folding them into someone else's running turn would lose the turn.
    serverEnqueueMessage('session-restore', '[session supervisor] continue', {}, { userId: 1 });
    await settle();

    assert.equal(harness.attempts.length, 0, 'no steer is attempted');
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

    assert.equal(harness.attempts.length, 0, 'there is no turn to steer');
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
    assert.equal(harness.attempts.length, 0);
    assert.equal(harness.drainedRuns.length, 0);
  });
});

// ---------------------------------------------------------------------------
// The turn ending while an injection is still in flight
// ---------------------------------------------------------------------------

/**
 * The race the parent reproduced: `completeRun` fires the drain while the
 * accepted injection is still awaiting its acknowledgement. Before the claim,
 * `dequeueNext` skipped only items already stamped `deliveredUuid` — which this
 * one is not yet — so the same answer both steered into the turn and started a
 * second run of its own.
 */
test('an accepted steer racing turn completion is not also drained', async () => {
  await withIsolatedDatabase(async (harness) => {
    startWorkingSession('session-accepted-race');

    serverEnqueueMessage('session-accepted-race', 'once only', {}, { deliverMidTurn: true });
    await settle();
    assert.equal(harness.attempts.length, 1, 'the injection is in flight');

    chatRunRegistry.completeRun('session-accepted-race', { exitCode: 0 });
    await letPendingWorkRun();
    assert.deepEqual(
      harness.drainedRuns, [],
      'the drain cannot take a message an injection is still deciding on',
    );

    harness.attempts[0]?.settle({ kind: 'accept', uuid: 'accepted-late' });
    await letPendingWorkRun();

    assert.equal(harness.attempts.length, 1, 'no second injection');
    assert.deepEqual(
      harness.drainedRuns, [],
      'and the accepted answer never becomes a queued run as well',
    );
  });
});

test('a definite refusal that arrives after the turn ended still runs as its own turn', async () => {
  await withIsolatedDatabase(async (harness) => {
    startWorkingSession('session-declined-race');

    serverEnqueueMessage('session-declined-race', 'answer racing', {}, { deliverMidTurn: true });
    await settle();
    assert.equal(harness.attempts.length, 1, 'the injection is in flight');

    // The turn finishes before the runtime answers, so the registry's own drain
    // runs against a queue whose item is still claimed by the attempt.
    chatRunRegistry.completeRun('session-declined-race', { exitCode: 0 });
    await letPendingWorkRun();
    assert.deepEqual(harness.drainedRuns, [], 'nothing runs while the answer is undecided');

    harness.attempts[0]?.settle({ kind: 'decline' });
    await waitFor(() => harness.drainedRuns.length > 0, 'the refused answer to run');

    assert.deepEqual(
      harness.drainedRuns, ['answer racing'],
      'a refusal is proof nothing was sent, so the queue sends it',
    );
  });
});

test('an answer the runtime declines mid-turn still runs when the turn ends', async () => {
  await withIsolatedDatabase(async (harness) => {
    startWorkingSession('session-declined');
    harness.autoSettle = { kind: 'decline' };

    serverEnqueueMessage('session-declined', 'answer fallback', {}, { deliverMidTurn: true });
    await settle();

    assert.equal(harness.attempts.length, 1, 'delivery was attempted');
    assert.equal(harness.drainedRuns.length, 0, 'but nothing runs while the turn is live');
    const [pending] = queueOf('session-declined');
    assert.equal(pending?.content, 'answer fallback', 'the operator sees it still pending');
    assert.equal(pending?.deliveryUnresolved, false, 'a refusal is not an unresolved delivery');

    chatRunRegistry.completeRun('session-declined', { exitCode: 0 });
    await waitFor(() => harness.drainedRuns.length > 0, 'the queued answer to run');

    assert.deepEqual(harness.drainedRuns, ['answer fallback'], 'the queue remains responsible for it');
  });
});

// ---------------------------------------------------------------------------
// Outcomes nobody can read: never re-sent, always visible
// ---------------------------------------------------------------------------

test('an injection that throws leaves the answer visibly unresolved, not re-sent', async () => {
  await withIsolatedDatabase(async (harness) => {
    startWorkingSession('session-throw');
    harness.autoSettle = { kind: 'throw', message: 'app-server connection reset' };

    serverEnqueueMessage('session-throw', 'restart the deploy', {}, { deliverMidTurn: true });
    await letPendingWorkRun();

    const [item] = queueOf('session-throw');
    assert.equal(item?.content, 'restart the deploy', 'the message is still on the card');
    assert.equal(item?.deliveryUnresolved, true, 'and the card says the delivery is unresolved');
    assert.equal(item?.delivered, false);

    // The turn ends. A failed steer may still have reached the runtime, so the
    // drain must not run the same instruction a second time.
    chatRunRegistry.completeRun('session-throw', { exitCode: 0 });
    await letPendingWorkRun();

    assert.deepEqual(harness.drainedRuns, [], 'an unknown outcome is never resolved by re-sending');
    assert.equal(harness.attempts.length, 1, 'and never by re-injecting either');
    assert.equal(queueOf('session-throw')[0]?.deliveryUnresolved, true, 'it stays flagged');
  });
});

test('an injection that never answers is flagged at the deadline and still not re-sent', async () => {
  await withIsolatedDatabase(async (harness) => {
    startWorkingSession('session-wedged');
    setMidTurnDeliveryDeadlineForTests(20);
    harness.autoSettle = { kind: 'hold' };

    serverEnqueueMessage('session-wedged', 'redeploy prod', {}, { deliverMidTurn: true });
    await waitFor(
      () => queueOf('session-wedged')[0]?.deliveryUnresolved === true,
      'the deadline to flag the card',
    );

    chatRunRegistry.completeRun('session-wedged', { exitCode: 0 });
    await letPendingWorkRun();

    assert.deepEqual(harness.drainedRuns, [], 'a wedged delivery is not a licence to re-send');
    assert.equal(harness.attempts.length, 1);
  });
});

test('an acknowledgement that arrives after the deadline settles ownership on the runtime', async () => {
  await withIsolatedDatabase(async (harness) => {
    startWorkingSession('session-late-ack');
    setMidTurnDeliveryDeadlineForTests(20);
    harness.autoSettle = { kind: 'hold' };

    serverEnqueueMessage('session-late-ack', 'answer late ack', {}, { deliverMidTurn: true });
    await waitFor(
      () => queueOf('session-late-ack')[0]?.deliveryUnresolved === true,
      'the deadline to flag the card',
    );

    chatRunRegistry.completeRun('session-late-ack', { exitCode: 0 });
    await letPendingWorkRun();

    // The runtime finally answers: it did take the message. Claude reports the
    // lifecycle event separately, so the card flips to delivered and waits.
    harness.attempts[0]?.settle({ kind: 'accept', uuid: 'late-uuid', reportDelivered: false });
    await letPendingWorkRun();

    const [item] = queueOf('session-late-ack');
    assert.equal(item?.delivered, true, 'the late ack resolves ownership onto the runtime');
    assert.equal(item?.deliveryUnresolved, false, 'so the card stops saying unresolved');
    assert.deepEqual(harness.drainedRuns, [], 'and the drain still never takes it');
  });
});

test('a refusal that arrives after the deadline hands the answer back to the drain', async () => {
  await withIsolatedDatabase(async (harness) => {
    startWorkingSession('session-late-refusal');
    setMidTurnDeliveryDeadlineForTests(20);
    harness.autoSettle = { kind: 'hold' };

    serverEnqueueMessage('session-late-refusal', 'answer late refusal', {}, { deliverMidTurn: true });
    await waitFor(
      () => queueOf('session-late-refusal')[0]?.deliveryUnresolved === true,
      'the deadline to flag the card',
    );

    chatRunRegistry.completeRun('session-late-refusal', { exitCode: 0 });
    await letPendingWorkRun();
    assert.deepEqual(harness.drainedRuns, [], 'still undecided, still not sent');

    harness.attempts[0]?.settle({ kind: 'decline' });
    await waitFor(() => harness.drainedRuns.length > 0, 'the refused answer to run');

    assert.deepEqual(
      harness.drainedRuns, ['answer late refusal'],
      'a late but definite refusal is proof, and proof releases the message',
    );
  });
});

test('a runtime that reports the message started, then fails, counts as delivered', async () => {
  await withIsolatedDatabase(async (harness) => {
    startWorkingSession('session-callback-first');
    // Codex fires `onDelivered` inside `turn/steer`; the call can still fail on
    // the way back. The callback is the stronger signal.
    harness.autoSettle = undefined;

    serverEnqueueMessage('session-callback-first', 'already started', {}, { deliverMidTurn: true });
    await settle();
    const attempt = harness.attempts[0];
    assert.ok(attempt);
    (attempt.options.onDelivered as (() => void) | undefined)?.();
    attempt.settle({ kind: 'throw', message: 'stream closed after delivery' });
    await letPendingWorkRun();

    assert.deepEqual(queueOf('session-callback-first'), [], 'the runtime owns it, so the card is gone');

    chatRunRegistry.completeRun('session-callback-first', { exitCode: 0 });
    await letPendingWorkRun();
    assert.deepEqual(harness.drainedRuns, [], 'and it is never sent a second time');
  });
});

// ---------------------------------------------------------------------------
// Bursts
// ---------------------------------------------------------------------------

test('a burst of answers is delivered once each, with only the refused one queued', async () => {
  await withIsolatedDatabase(async (harness) => {
    startWorkingSession('session-burst');

    serverEnqueueMessage('session-burst', 'first', {}, { deliverMidTurn: true });
    serverEnqueueMessage('session-burst', 'second', {}, { deliverMidTurn: true });
    serverEnqueueMessage('session-burst', 'third', {}, { deliverMidTurn: true });
    await settle();

    assert.equal(harness.attempts.length, 3, 'each message is attempted on its own');
    assert.deepEqual(
      harness.attempts.map((attempt) => attempt.content), ['first', 'second', 'third'],
      'in the order they were submitted',
    );

    // The turn ends while all three are undecided.
    chatRunRegistry.completeRun('session-burst', { exitCode: 0 });
    await letPendingWorkRun();
    assert.deepEqual(harness.drainedRuns, [], 'none of them can be drained mid-flight');

    harness.attempts[0]?.settle({ kind: 'accept', uuid: 'burst-1' });
    harness.attempts[2]?.settle({ kind: 'accept', uuid: 'burst-3' });
    harness.attempts[1]?.settle({ kind: 'decline' });
    await waitFor(() => harness.drainedRuns.length > 0, 'the refused message to run');
    await letPendingWorkRun();

    assert.deepEqual(
      harness.drainedRuns, ['second'],
      'exactly the refused one runs, exactly once',
    );
    assert.equal(harness.attempts.length, 3, 'and no message is injected twice');
  });
});

test('several refusals in a burst drain in submission order, once each', async () => {
  await withIsolatedDatabase(async (harness) => {
    startWorkingSession('session-burst-refused');
    harness.autoSettle = { kind: 'decline' };

    serverEnqueueMessage('session-burst-refused', 'alpha', {}, { deliverMidTurn: true });
    serverEnqueueMessage('session-burst-refused', 'beta', {}, { deliverMidTurn: true });
    serverEnqueueMessage('session-burst-refused', 'gamma', {}, { deliverMidTurn: true });
    await letPendingWorkRun();

    assert.deepEqual(harness.drainedRuns, [], 'the live turn still owns the session');

    chatRunRegistry.completeRun('session-burst-refused', { exitCode: 0 });
    await waitFor(() => harness.drainedRuns.length === 3, 'all three refused answers to run');
    await letPendingWorkRun();

    assert.deepEqual(harness.drainedRuns, ['alpha', 'beta', 'gamma']);
  });
});

// ---------------------------------------------------------------------------
// Cancelling, stopping, and the composer's own path
// ---------------------------------------------------------------------------

test('a queued message cannot be cancelled while its delivery is in flight', async () => {
  await withIsolatedDatabase(async (harness) => {
    startWorkingSession('session-cancel-inflight');
    // Long enough that the attempt is still undecided for the whole case.
    setMidTurnDeliveryDeadlineForTests(60_000);
    harness.autoSettle = { kind: 'hold' };
    const socket = connect();

    // `chat.queue-add` only returns once delivery has been decided, so the
    // in-flight window is observed while that frame is still being handled.
    void sendFrame(socket, {
      type: 'chat.queue-add',
      sessionId: 'session-cancel-inflight',
      id: 'queued-cancel-1',
      content: 'cancel me',
      options: {},
    });
    await waitFor(() => harness.attempts.length === 1, 'the composer message to be handed over');

    await sendFrame(socket, {
      type: 'chat.queue-remove',
      sessionId: 'session-cancel-inflight',
      id: 'queued-cancel-1',
    });
    await letPendingWorkRun();

    assert.equal(
      queueOf('session-cancel-inflight').length, 1,
      'it stays: there is no id to recall it by yet, so it cannot be declared cancelled',
    );
    const removals = socket
      .framesOfKind('queue_updated')
      .flatMap((frame) => (frame.removed as unknown[]) ?? []);
    assert.deepEqual(removals, [], 'and the client is never told its text came back');

    // The claim is still held, so the end of the turn cannot drain it either.
    chatRunRegistry.completeRun('session-cancel-inflight', { exitCode: 0 });
    await letPendingWorkRun();
    assert.deepEqual(harness.drainedRuns, []);
  });
});

test('an unresolved message can be taken back by the operator, and is not re-sent after', async () => {
  await withIsolatedDatabase(async (harness) => {
    startWorkingSession('session-cancel-unresolved');
    setMidTurnDeliveryDeadlineForTests(20);
    harness.autoSettle = { kind: 'hold' };
    const socket = connect();

    await sendFrame(socket, {
      type: 'chat.queue-add',
      sessionId: 'session-cancel-unresolved',
      id: 'queued-cancel-2',
      content: 'take me back',
      options: {},
    });
    await waitFor(
      () => queueOf('session-cancel-unresolved')[0]?.deliveryUnresolved === true,
      'the deadline to flag the card',
    );

    await sendFrame(socket, {
      type: 'chat.queue-remove',
      sessionId: 'session-cancel-unresolved',
      id: 'queued-cancel-2',
    });
    await letPendingWorkRun();

    assert.deepEqual(queueOf('session-cancel-unresolved'), [], 'the operator took it back');
    const removals = socket
      .framesOfKind('queue_updated')
      .flatMap((frame) => (frame.removed as Array<Record<string, unknown>>) ?? []);
    assert.equal(removals.at(-1)?.content, 'take me back', 'the text goes back to the composer');
    assert.equal(removals.at(-1)?.reason, 'cancelled');

    // A late answer must not resurrect it in any form.
    harness.attempts[0]?.settle({ kind: 'accept', uuid: 'too-late' });
    chatRunRegistry.completeRun('session-cancel-unresolved', { exitCode: 0 });
    await letPendingWorkRun();
    assert.deepEqual(harness.drainedRuns, []);
    assert.deepEqual(queueOf('session-cancel-unresolved'), []);
  });
});

test('Stop clears a message whose delivery is in flight without it running afterwards', async () => {
  await withIsolatedDatabase(async (harness) => {
    startWorkingSession('session-stop');
    harness.autoSettle = { kind: 'hold' };

    serverEnqueueMessage('session-stop', 'stop me', {}, { deliverMidTurn: true });
    await settle();
    assert.equal(harness.attempts.length, 1);

    await serverAbortRun('session-stop');
    await letPendingWorkRun();
    assert.deepEqual(queueOf('session-stop'), [], 'Stop means stop: the queue is cleared');

    // The abandoned injection answers afterwards, either way.
    harness.attempts[0]?.settle({ kind: 'accept', uuid: 'after-stop' });
    await letPendingWorkRun();

    assert.deepEqual(harness.drainedRuns, [], 'nothing is started by a post-Stop answer');
    assert.deepEqual(queueOf('session-stop'), [], 'and nothing comes back into the queue');
  });
});

test('a repeated queue-add for the same id is delivered once', async () => {
  await withIsolatedDatabase(async (harness) => {
    startWorkingSession('session-repeat');
    setMidTurnDeliveryDeadlineForTests(60_000);
    harness.autoSettle = { kind: 'hold' };
    const socket = connect();

    const frame = {
      type: 'chat.queue-add',
      sessionId: 'session-repeat',
      id: 'queued-repeat-1',
      content: 'said once',
      options: {},
    };
    // The replay lands while the first add is still awaiting its answer — the
    // reconnect case, where a client re-sends a frame it never saw acked.
    void sendFrame(socket, frame);
    await waitFor(() => harness.attempts.length === 1, 'the first delivery to start');
    await sendFrame(socket, frame);
    await letPendingWorkRun();

    assert.equal(harness.attempts.length, 1, 'the second add finds the item already claimed');
    assert.equal(queueOf('session-repeat').length, 1, 'and does not double the queue');
  });
});

// ---------------------------------------------------------------------------
// A full queue is refused, never quietly trimmed
// ---------------------------------------------------------------------------

test('a full queue refuses the newest message instead of dropping the oldest', async () => {
  await withIsolatedDatabase(async (harness) => {
    // Idle would drain, so hold the session in a turn nothing answers.
    startWorkingSession('session-full-working');

    for (let index = 0; index < 20; index += 1) {
      assert.equal(
        serverEnqueueMessage('session-full-working', `message ${index}`, {}, { userId: 1 }),
        true,
        `message ${index} fits`,
      );
    }
    assert.equal(queueOf('session-full-working').length, 20);

    assert.equal(
      serverEnqueueMessage('session-full-working', 'one too many', {}, { userId: 1 }),
      false,
      'the caller is told it was not taken, so it records a refusal not a receipt',
    );

    const queue = queueOf('session-full-working');
    assert.equal(queue.length, 20, 'the queue is unchanged');
    assert.equal(queue[0]?.content, 'message 0', 'and the oldest answer was not thrown away');
    assert.equal(
      queue.some((item) => item.content === 'one too many'), false,
      'the refused message is nowhere in it',
    );
    assert.equal(harness.drainedRuns.length, 0);
  });
});

test('the composer is told when its message did not fit, rather than losing an older one', async () => {
  await withIsolatedDatabase(async (harness) => {
    startWorkingSession('session-full-composer');
    const socket = connect();

    for (let index = 0; index < 20; index += 1) {
      serverEnqueueMessage('session-full-composer', `queued ${index}`, {}, { userId: 1 });
    }
    assert.equal(queueOf('session-full-composer').length, 20);

    await sendFrame(socket, {
      type: 'chat.queue-add',
      sessionId: 'session-full-composer',
      id: 'queued-overflow',
      content: 'does not fit',
      options: {},
    });
    await letPendingWorkRun();

    const errors = socket.framesOfKind('protocol_error');
    assert.equal(errors.length, 1, 'the client hears about it');
    assert.equal(errors[0]?.code, 'QUEUE_FULL');
    assert.equal(harness.attempts.length, 0, 'a message that was not queued is not delivered');
    const queue = queueOf('session-full-composer');
    assert.equal(queue.length, 20);
    assert.equal(queue[0]?.content, 'queued 0', 'no older message was dropped to make room');
  });
});
