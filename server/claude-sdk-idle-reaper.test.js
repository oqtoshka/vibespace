import assert from 'node:assert/strict';
import test from 'node:test';

// The idle window has to be short enough to fire inside a test and long enough
// that ordinary scheduling jitter doesn't trip it. Set before the import: the
// module reads these into consts at load time.
process.env.CLAUDE_SESSION_IDLE_TIMEOUT_MS = '80';
process.env.CLAUDE_ABORT_MIN_TURN_AGE_MS = '0';

const {
  queryClaudeSDK,
  abortClaudeSDKSession,
  isClaudeSDKSessionAlive,
  getPendingApprovalsForSession,
  resolveToolApproval,
  TOOL_APPROVAL_TIMEOUT_MS,
  __setClaudeQueryImpl,
} = await import('./claude-sdk.js');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function makeRecordingWriter() {
  const messages = [];
  const waiters = [];
  return {
    userId: null,
    isWebSocketWriter: true,
    ws: { readyState: 1, send() {} },
    setSessionId() {},
    send(msg) {
      messages.push(msg);
      for (const w of waiters.slice()) {
        if (w.predicate(messages)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve();
        }
      }
    },
    messages,
    waitFor(predicate, label) {
      if (predicate(messages)) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for: ${label}`)), 3000);
        waiters.push({ predicate, resolve: () => { clearTimeout(timer); resolve(); } });
      });
    },
  };
}

const assistantText = (text, sessionId) => ({
  type: 'assistant',
  session_id: sessionId,
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});
const resultMsg = (sessionId) => ({ type: 'result', subtype: 'success', session_id: sessionId });

// The idle timer is armed when a turn settles and cleared when the next one
// starts — but the runtime can start a turn on its own (draining a queued
// message, resuming after a background job) and the previous turn's `result`
// may land after it. Assistant output re-arms `awaitingResult` without touching
// the timer, so the session runs on with a live reaper pointed at it. This is
// the shape that killed sessions mid-turn in production.
test('a turn still in flight is not reaped by an idle timer armed by the previous turn', async () => {
  const sessionId = 'idle-race-1';

  const fakeQuery = ({ prompt }) => {
    const reader = prompt[Symbol.asyncIterator]();
    const gen = (async function* () {
      await reader.next();
      yield assistantText('turn one', sessionId);
      yield resultMsg(sessionId);           // settles -> arms the idle timer

      // The runtime opens the next turn itself. Nothing clears the timer.
      yield assistantText('turn two, still working', sessionId);
      await delay(300);                     // outlives the 80ms idle window
      yield resultMsg(sessionId);
    })();
    gen.interrupt = async () => {};
    gen.setModel = async () => {};
    gen.setPermissionMode = async () => {};
    return gen;
  };

  __setClaudeQueryImpl(fakeQuery);
  const writer = makeRecordingWriter();

  try {
    await queryClaudeSDK('do something long', { sessionId, ephemeral: false }, writer);
    await writer.waitFor(
      (msgs) => msgs.some((m) => JSON.stringify(m).includes('still working')),
      'second turn in flight',
    );

    // Straddle the idle window while the second turn is mid-flight.
    await delay(200);
    assert.equal(isClaudeSDKSessionAlive(sessionId), true, 'session must survive its own live turn');

    await writer.waitFor(
      (msgs) => msgs.filter((m) => m.kind === 'complete').length >= 2,
      'second turn completes',
    );
  } finally {
    await abortClaudeSDKSession(sessionId).catch(() => {});
    __setClaudeQueryImpl(null);
  }
});

// Ordinary tool prompts (Bash, Edit, …) used to expire after 55s and return
// deny, which the CLI reports to the model as "The user doesn't want to proceed
// with this tool use". A user who simply wasn't looking at the tab came back to
// a transcript claiming they had declined something they never saw — so no
// permission prompt may answer itself, whatever the tool.
test('an unanswered prompt for an ordinary tool never resolves into a deny', async () => {
  const sessionId = 'approval-no-timeout-1';
  const captured = {};

  const fakeQuery = ({ prompt, options }) => {
    const reader = prompt[Symbol.asyncIterator]();
    const gen = (async function* () {
      await reader.next();
      captured.decision = options.canUseTool('Bash', { command: 'npx jest --silent' }, {});
      yield resultMsg(sessionId);
      await captured.answered;
      yield resultMsg(sessionId);
    })();
    gen.interrupt = async () => {};
    gen.setModel = async () => {};
    gen.setPermissionMode = async () => {};
    return gen;
  };

  let release;
  captured.answered = new Promise((r) => { release = r; });

  __setClaudeQueryImpl(fakeQuery);
  const writer = makeRecordingWriter();

  try {
    await queryClaudeSDK('run the tests', { sessionId, ephemeral: false }, writer);

    const request = writer.messages.find((m) => m.kind === 'permission_request');
    assert.ok(request, 'the prompt should have reached the client');

    // The real guard: no default deadline at all. A wall-clock wait can only
    // prove the absence of a *short* timer, and the one that caused this was
    // 55s — longer than any test should sit.
    assert.equal(TOOL_APPROVAL_TIMEOUT_MS, 0, 'ordinary tool prompts must have no deadline by default');

    // Belt and braces: nothing else in the wait settles it early either.
    const sentinel = Symbol('unanswered');
    const outcome = await Promise.race([
      captured.decision,
      delay(300).then(() => sentinel),
    ]);
    assert.equal(outcome, sentinel, 'the prompt must not answer itself');
    assert.equal(getPendingApprovalsForSession(sessionId).length, 1, 'the prompt is still answerable');
    assert.ok(
      !writer.messages.some((m) => m.kind === 'permission_cancelled'),
      'no cancellation should have been announced to the client',
    );

    resolveToolApproval(request.requestId, { allow: true });
    assert.equal((await captured.decision).behavior, 'allow');
    release();
  } finally {
    await abortClaudeSDKSession(sessionId).catch(() => {});
    __setClaudeQueryImpl(null);
  }
});

// An interactive prompt waits indefinitely by design, so a session parked on
// one looks idle from the outside: no output, no running job. Reaping it closes
// the input stream under the CLI's in-flight permission request, which lands in
// the transcript as "Tool permission stream closed before response received" —
// indistinguishable, on reopening the session, from the user having declined.
test('a session parked on an unanswered permission prompt is not reaped', async () => {
  const sessionId = 'idle-approval-1';
  const captured = {};

  const fakeQuery = ({ prompt, options }) => {
    const reader = prompt[Symbol.asyncIterator]();
    const gen = (async function* () {
      await reader.next();
      yield assistantText('about to ask', sessionId);
      // Park exactly where the runtime parks: inside canUseTool, awaiting a
      // human. Deliberately not awaited here — the generator must keep the turn
      // open while the promise is outstanding.
      captured.decision = options.canUseTool(
        'AskUserQuestion',
        { questions: [{ question: 'which way?' }] },
        {},
      );
      yield resultMsg(sessionId);           // the turn settles; the prompt does not
      await captured.answered;
      yield assistantText('got the answer', sessionId);
      yield resultMsg(sessionId);
    })();
    gen.interrupt = async () => {};
    gen.setModel = async () => {};
    gen.setPermissionMode = async () => {};
    return gen;
  };

  let release;
  captured.answered = new Promise((r) => { release = r; });

  __setClaudeQueryImpl(fakeQuery);
  const writer = makeRecordingWriter();

  try {
    await queryClaudeSDK('ask me something', { sessionId, ephemeral: false }, writer);

    const request = writer.messages.find((m) => m.kind === 'permission_request');
    assert.ok(request, 'the prompt should have reached the client');

    // Sit past the idle window with the question unanswered, as a user who
    // stepped away would.
    await delay(250);
    assert.equal(isClaudeSDKSessionAlive(sessionId), true, 'session must outlive an unanswered prompt');
    assert.equal(getPendingApprovalsForSession(sessionId).length, 1, 'the prompt is still answerable');

    // Answering late still works — the whole point of keeping it alive.
    resolveToolApproval(request.requestId, { allow: true });
    const decision = await captured.decision;
    assert.equal(decision.behavior, 'allow');
    release();
  } finally {
    await abortClaudeSDKSession(sessionId).catch(() => {});
    __setClaudeQueryImpl(null);
  }
});
