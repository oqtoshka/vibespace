import assert from 'node:assert/strict';
import test from 'node:test';

import {
  queryClaudeSDK,
  abortClaudeSDKSession,
  isClaudeSDKSessionActive,
  isClaudeSDKSessionAlive,
  __setClaudeQueryImpl,
  __setRewindHistoryImpl,
} from './claude-sdk.js';

// A writer that records every normalized message the session pushes out, and
// lets a test await the moment a predicate becomes true.
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
        const timer = setTimeout(() => reject(new Error(`timed out waiting for: ${label}`)), 2000);
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
const taskStarted = (taskId, sessionId) => ({ type: 'system', subtype: 'task_started', task_id: taskId, description: 'poll host', session_id: sessionId });
const taskNotification = (taskId, sessionId) => ({
  type: 'system', subtype: 'task_notification', task_id: taskId, tool_use_id: 'toolu_1',
  status: 'completed', output_file: '/tmp/out.txt', summary: 'host is up', session_id: sessionId,
});

// Builds a fake Query: an async iterator the loop consumes, scripted to react to
// the input stream the session pushes into it. Captures any injected messages.
function makeFakeQuery(sessionId, captured) {
  return ({ prompt }) => {
    const reader = prompt[Symbol.asyncIterator]();
    const gen = (async function* () {
      // Turn 1: consume the user's first message, launch a background job, end
      // the turn while the job is still running.
      const first = await reader.next();
      captured.firstUserMessage = first.value;
      yield assistantText('launching background poll', sessionId);
      yield taskStarted('t1', sessionId);
      yield resultMsg(sessionId);

      // Between turns: the background job completes. The session should inject a
      // <task-notification> user message; read it back to prove the auto-resume.
      yield taskNotification('t1', sessionId);
      const injected = await reader.next();
      captured.injectedMessage = injected.value;

      // Turn 2 (the auto-resumed turn).
      yield assistantText('the host came up — continuing', sessionId);
      yield resultMsg(sessionId);
    })();
    gen.interrupt = async () => {};
    gen.setModel = async () => {};
    gen.setPermissionMode = async () => {};
    return gen;
  };
}

test('background job completion auto-resumes the agent with a task-notification', async () => {
  const sessionId = 'bg-session-1';
  const captured = {};
  __setClaudeQueryImpl(makeFakeQuery(sessionId, captured));
  const writer = makeRecordingWriter();

  try {
    // queryClaudeSDK resolves when turn 1 completes; the session lives on.
    await queryClaudeSDK('watch the host and tell me when it is up', { sessionId, ephemeral: false }, writer);

    // Turn 1 produced a completion.
    const completes = writer.messages.filter((m) => m.kind === 'complete');
    assert.ok(completes.length >= 1, 'turn 1 should emit a complete');

    // The agent should auto-resume: wait for turn 2's assistant text to stream.
    await writer.waitFor(
      (msgs) => msgs.some((m) => JSON.stringify(m).includes('the host came up')),
      'auto-resumed assistant output',
    );

    // The injected message must be the harness-style task-notification, as a
    // user message — NOT a fabricated user instruction.
    const injected = captured.injectedMessage;
    assert.ok(injected, 'a message should have been injected to resume the agent');
    assert.equal(injected.type, 'user');
    const content = injected.message.content;
    assert.match(content, /\[SYSTEM NOTIFICATION - NOT USER INPUT\]/);
    assert.match(content, /<task-notification>/);
    assert.match(content, /<task-id>t1<\/task-id>/);
    assert.match(content, /<status>completed<\/status>/);
    assert.match(content, /host is up/);

    // After both turns drain with no pending jobs, two completes total.
    await writer.waitFor((msgs) => msgs.filter((m) => m.kind === 'complete').length >= 2, 'second complete');
  } finally {
    await abortClaudeSDKSession(sessionId).catch(() => {});
    __setClaudeQueryImpl(null);
  }
});

test('a foreground subagent completing mid-turn does NOT inject a task-notification', async () => {
  const sessionId = 'fg-session-1';
  const captured = {};
  // Subagent task starts AND completes before the turn's result — should never
  // be treated as a background job, so no resume injection.
  const fakeQuery = ({ prompt }) => {
    const reader = prompt[Symbol.asyncIterator]();
    const gen = (async function* () {
      await reader.next();
      yield assistantText('spawning a subagent', sessionId);
      yield taskStarted('sub1', sessionId);
      yield taskNotification('sub1', sessionId); // completes DURING the turn
      yield assistantText('subagent done', sessionId);
      yield resultMsg(sessionId);
    })();
    gen.interrupt = async () => {};
    return gen;
  };
  __setClaudeQueryImpl(fakeQuery);
  const writer = makeRecordingWriter();

  try {
    await queryClaudeSDK('do a thing with a subagent', { sessionId }, writer);
    await writer.waitFor((msgs) => msgs.filter((m) => m.kind === 'complete').length >= 1, 'turn complete');
    assert.equal(captured.injectedMessage, undefined, 'no resume injection for a foreground subagent');
  } finally {
    await abortClaudeSDKSession(sessionId).catch(() => {});
    __setClaudeQueryImpl(null);
  }
});

test('stop interrupts the turn but keeps the session and its background job alive, which still auto-resumes', async () => {
  const sessionId = 'stop-keepalive-1';
  const captured = {};
  let releaseInterrupt;
  let releaseJob;
  const interruptedResult = new Promise((r) => { releaseInterrupt = r; });
  const jobDone = new Promise((r) => { releaseJob = r; });

  const fakeQuery = ({ prompt }) => {
    const reader = prompt[Symbol.asyncIterator]();
    const gen = (async function* () {
      await reader.next();
      yield assistantText('launched background job, still working', sessionId);
      yield taskStarted('t1', sessionId);
      await interruptedResult;             // stay mid-turn until the stop interrupts us
      yield resultMsg(sessionId);          // interrupt ends the turn (job t1 still running)
      await jobDone;                       // job keeps running after the stop
      yield taskNotification('t1', sessionId);
      const injected = await reader.next();
      captured.injectedMessage = injected.value;
      yield assistantText('background job finished — resuming after the stop', sessionId);
      yield resultMsg(sessionId);
    })();
    gen.interrupt = async () => { releaseInterrupt(); };
    return gen;
  };

  __setClaudeQueryImpl(fakeQuery);
  process.env.CLAUDE_ABORT_MIN_TURN_AGE_MS = '0'; // disable the phantom-abort grace for the test
  const writer = makeRecordingWriter();

  try {
    const turn = queryClaudeSDK('launch a background poll and keep working', { sessionId }, writer);
    await writer.waitFor((msgs) => msgs.some((m) => JSON.stringify(m).includes('still working')), 'turn in flight');
    assert.equal(isClaudeSDKSessionActive(sessionId), true, 'turn is processing before stop');

    // Press stop. Mirrors Esc: interrupt the turn, but DON'T kill the session/job.
    await abortClaudeSDKSession(sessionId);
    await turn;

    assert.equal(isClaudeSDKSessionAlive(sessionId), true, 'session survives the stop (background job still running)');
    assert.equal(isClaudeSDKSessionActive(sessionId), false, 'no turn is processing after the stop');
    assert.equal(captured.injectedMessage, undefined, 'no resume yet — the job has not finished');

    // The background job finishes after the stop — the agent must still wake.
    releaseJob();
    await writer.waitFor(
      (msgs) => msgs.some((m) => JSON.stringify(m).includes('resuming after the stop')),
      'auto-resume after stop',
    );
    assert.ok(captured.injectedMessage, 'background job auto-resumed the agent even though the turn was stopped');
    assert.match(captured.injectedMessage.message.content, /<task-notification>/);
  } finally {
    delete process.env.CLAUDE_ABORT_MIN_TURN_AGE_MS;
    __setClaudeQueryImpl(null);
  }
});

test('a rewind tears down the live session and resumes a fresh query from the truncated transcript', async () => {
  const sessionId = 'rewind-session-1';
  const queryInvocations = [];

  // Two query lifetimes: the original session, then the post-rewind resume.
  const fakeQuery = ({ prompt, options }) => {
    const index = queryInvocations.length;
    queryInvocations.push({ options });
    const reader = prompt[Symbol.asyncIterator]();
    const gen = (async function* () {
      const first = await reader.next();
      if (index === 0) {
        // Original session: stream, then idle (stay alive between turns). Parking
        // on the input stream mirrors the real SDK — closing input ends the query.
        yield assistantText('original answer', sessionId);
        yield resultMsg(sessionId);
        await reader.next(); // resolves done when endSession() closes the input
      } else {
        // The resumed (rewound) turn — capture the edited prompt it received.
        queryInvocations[index].firstUserMessage = first.value;
        yield assistantText('rewound answer', sessionId);
        yield resultMsg(sessionId);
      }
    })();
    gen.interrupt = async () => {};
    return gen;
  };

  __setClaudeQueryImpl(fakeQuery);
  let rewindArgs = null;
  __setRewindHistoryImpl(async (sid, uuid) => {
    rewindArgs = { sid, uuid };
    return { ok: true, startFresh: false, removed: 3 };
  });
  const writer = makeRecordingWriter();

  try {
    await queryClaudeSDK('first message', { sessionId, ephemeral: false }, writer);
    await writer.waitFor((msgs) => msgs.some((m) => JSON.stringify(m).includes('original answer')), 'original turn');
    assert.equal(isClaudeSDKSessionAlive(sessionId), true, 'session is live after the first turn');

    // Edit-and-resend an earlier message.
    await queryClaudeSDK('edited message', { sessionId, rewind: 'msg-uuid-2' }, writer);

    assert.deepEqual(rewindArgs, { sid: sessionId, uuid: 'msg-uuid-2' }, 'rewind anchored on the edited message');
    await writer.waitFor((msgs) => msgs.some((m) => JSON.stringify(m).includes('rewound answer')), 'resumed turn');

    // The resume re-spawned the query with resume pointed at the same session id.
    assert.equal(queryInvocations.length, 2, 'a fresh query was started after the rewind');
    assert.equal(queryInvocations[1].options.resume, sessionId, 'the resumed query loads the truncated transcript');
    const injected = queryInvocations[1].firstUserMessage;
    assert.equal(injected?.message?.content, 'edited message', 'the edited message is replayed as the new turn');
  } finally {
    await abortClaudeSDKSession(sessionId).catch(() => {});
    __setClaudeQueryImpl(null);
    __setRewindHistoryImpl(null);
  }
});

test('a mid-session permission mode change is applied to the live session on reuse', async () => {
  const sessionId = 'mode-switch-session-1';
  const modeCalls = [];
  // Turn 1 (default mode), then a reused turn 2 sent with bypassPermissions.
  const fakeQuery = ({ prompt }) => {
    const reader = prompt[Symbol.asyncIterator]();
    const gen = (async function* () {
      await reader.next();
      yield assistantText('turn one', sessionId);
      yield resultMsg(sessionId);
      await reader.next();
      yield assistantText('turn two', sessionId);
      yield resultMsg(sessionId);
    })();
    gen.interrupt = async () => {};
    gen.setModel = async () => {};
    gen.setPermissionMode = async (mode) => { modeCalls.push(mode); };
    return gen;
  };
  __setClaudeQueryImpl(fakeQuery);
  const writer = makeRecordingWriter();

  try {
    await queryClaudeSDK('first message', { sessionId, permissionMode: 'default' }, writer);
    assert.deepEqual(modeCalls, [], 'no mode switch while the mode is unchanged');

    await queryClaudeSDK('now push it', { sessionId, permissionMode: 'bypassPermissions' }, writer);
    assert.deepEqual(modeCalls, ['bypassPermissions'], 'the reused session adopts the new mode');
  } finally {
    await abortClaudeSDKSession(sessionId).catch(() => {});
    __setClaudeQueryImpl(null);
  }
});

test('a mid-session reasoning effort change is applied to the live session on reuse', async () => {
  const sessionId = 'effort-switch-session-1';
  const flagSettingsCalls = [];
  // Turn 1 at the model default, then a reused turn 2 sent with effort 'max'.
  const fakeQuery = ({ prompt }) => {
    const reader = prompt[Symbol.asyncIterator]();
    const gen = (async function* () {
      await reader.next();
      yield assistantText('turn one', sessionId);
      yield resultMsg(sessionId);
      await reader.next();
      yield assistantText('turn two', sessionId);
      yield resultMsg(sessionId);
      await reader.next();
      yield assistantText('turn three', sessionId);
      yield resultMsg(sessionId);
    })();
    gen.interrupt = async () => {};
    gen.setModel = async () => {};
    gen.setPermissionMode = async () => {};
    gen.applyFlagSettings = async (settings) => { flagSettingsCalls.push(settings); };
    return gen;
  };
  __setClaudeQueryImpl(fakeQuery);
  const writer = makeRecordingWriter();

  try {
    await queryClaudeSDK('first message', { sessionId, model: 'sonnet', effort: 'default' }, writer);
    assert.deepEqual(flagSettingsCalls, [], 'no effort switch while the effort is unchanged');

    await queryClaudeSDK('think harder', { sessionId, model: 'sonnet', effort: 'max' }, writer);
    assert.deepEqual(
      flagSettingsCalls,
      [{ effortLevel: 'max' }],
      'the reused session adopts the new effort',
    );

    await queryClaudeSDK('back to normal', { sessionId, model: 'sonnet', effort: 'default' }, writer);
    assert.deepEqual(
      flagSettingsCalls.at(-1),
      { effortLevel: null },
      'returning to default clears the flag layer',
    );
  } finally {
    await abortClaudeSDKSession(sessionId).catch(() => {});
    __setClaudeQueryImpl(null);
  }
});

test('isClaudeSDKSessionActive reflects an in-flight turn, not mere liveness', async () => {
  const sessionId = 'active-session-1';
  // A query whose first turn never produces a result until we close input.
  let released;
  const hold = new Promise((r) => { released = r; });
  const fakeQuery = ({ prompt }) => {
    const reader = prompt[Symbol.asyncIterator]();
    const gen = (async function* () {
      await reader.next();
      yield assistantText('working...', sessionId);
      await hold; // stay mid-turn until released
      yield resultMsg(sessionId);
    })();
    gen.interrupt = async () => { released(); };
    return gen;
  };
  __setClaudeQueryImpl(fakeQuery);
  const writer = makeRecordingWriter();

  try {
    // Don't await — the turn is intentionally held open.
    const turn = queryClaudeSDK('long task', { sessionId }, writer);
    await writer.waitFor((msgs) => msgs.some((m) => JSON.stringify(m).includes('working...')), 'assistant started');
    assert.equal(isClaudeSDKSessionActive(sessionId), true, 'session is processing mid-turn');
    released();
    await turn;
    assert.equal(isClaudeSDKSessionActive(sessionId), false, 'session is idle after the turn');
  } finally {
    await abortClaudeSDKSession(sessionId).catch(() => {});
    __setClaudeQueryImpl(null);
  }
});
