import assert from 'node:assert/strict';
import test from 'node:test';

import {
  queryClaudeSDK,
  abortClaudeSDKSession,
  isClaudeSDKSessionActive,
  isClaudeSDKSessionAlive,
  __setClaudeQueryImpl,
  __setNativeWakeGraceMs,
  __setRewindHistoryImpl,
} from './claude-sdk.js';
import { __getSessionRestoreEntry } from './services/session-restore.service.js';

// Most fakes below model a runtime that does not wake the agent itself, so the
// fallback delivery must fire — immediately, for the test.
__setNativeWakeGraceMs(0);

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

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
// A main-thread assistant turn that launches background job toolu_1 — the
// notification is only the main thread's business when its tool_use is.
const launchBackground = (text, sessionId) => ({
  type: 'assistant',
  session_id: sessionId,
  message: { role: 'assistant', content: [{ type: 'text', text }, { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'poll', run_in_background: true } }] },
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
      yield launchBackground('launching background poll', sessionId);
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

// The run registry only flips a run to `completed` when a terminal `complete`
// passes through it, and `chat.send` / the queue drain each guarantee one from
// their own `finally`. A background auto-resume opens its run inside the SDK
// loop, so when the CLI died under the resumed turn nothing ever settled it:
// the session showed as processing on every client, further sends bounced off
// RUN_IN_PROGRESS, and /health's activeSessions kept counting it for days.
test('a turn that dies mid-stream still emits its terminal complete', async () => {
  const sessionId = 'crash-after-resume-1';
  const captured = {};

  const fakeQuery = ({ prompt }) => {
    const reader = prompt[Symbol.asyncIterator]();
    const gen = (async function* () {
      await reader.next();
      yield launchBackground('launching background poll', sessionId);
      yield taskStarted('t1', sessionId);
      yield resultMsg(sessionId);                 // turn 1 settles → complete #1

      yield taskNotification('t1', sessionId);    // auto-resume opens the next run
      captured.injectedMessage = (await reader.next()).value;
      // …and the CLI dies under it, the way SIGTERM surfaces from the SDK.
      throw new Error('Claude Code process exited with code 143');
    })();
    gen.interrupt = async () => {};
    gen.setModel = async () => {};
    gen.setPermissionMode = async () => {};
    return gen;
  };

  __setClaudeQueryImpl(fakeQuery);
  const writer = makeRecordingWriter();

  try {
    // Resolves when turn 1 settles; the auto-resume and the crash happen after.
    await queryClaudeSDK('watch the host', { sessionId, ephemeral: false }, writer);

    // The error path awaits an installed-provider check before tearing down, so
    // poll rather than racing a fixed deadline.
    const deadline = Date.now() + 8000;
    while (writer.messages.filter((m) => m.kind === 'complete').length < 2 && Date.now() < deadline) {
      await delay(10);
    }

    assert.ok(captured.injectedMessage, 'the background task should have auto-resumed the agent');

    const errors = writer.messages.filter((m) => m.kind === 'error');
    assert.equal(errors.length, 1, 'the crash should be reported once');
    assert.equal(
      writer.messages.filter((m) => m.kind === 'complete').length,
      2,
      'the resumed run must settle too — otherwise it stays "running" forever',
    );

    const last = writer.messages[writer.messages.length - 1];
    assert.equal(last.kind, 'complete');
    assert.equal(last.exitCode, 1, 'a crashed turn is not a success');
    assert.equal(last.success, false);
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
      yield launchBackground('launched background job, still working', sessionId);
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
      // Keep the persistent query alive so its restore entry remains present
      // while the assertion below simulates what the next boot would read.
      await reader.next();
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
    await delay(0);
    assert.equal(
      __getSessionRestoreEntry(sessionId)?.permissionMode,
      'bypassPermissions',
      'the restart registry persists the effective live mode, not the spawn-time default',
    );
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

// ---------------------------------------------------------------------------
// Task notifications: one per child task, only the parent's own, no echo of
// what the runtime already delivered.
// ---------------------------------------------------------------------------

// A fake whose script is a list of steps; every message the session pushes
// after the first user turn is recorded in `pushed`.
function makeScriptedQuery(steps, pushed) {
  return ({ prompt }) => {
    const reader = prompt[Symbol.asyncIterator]();
    const gen = (async function* () {
      await reader.next();
      (async () => {
        for (;;) {
          const next = await reader.next();
          if (next.done) return;
          pushed.push(next.value);
        }
      })().catch(() => {});
      for (const step of steps) {
        if (typeof step === 'function') await step();
        else yield step;
      }
      await new Promise(() => {}); // stay alive like a real session
    })();
    gen.interrupt = async () => {};
    gen.setModel = async () => {};
    gen.setPermissionMode = async () => {};
    return gen;
  };
}

const notification = (sessionId, fields) => ({
  type: 'system', subtype: 'task_notification', output_file: '/tmp/out.txt',
  status: 'completed', summary: 'done', session_id: sessionId, ...fields,
});

test('when the runtime wakes the agent itself, VibeSpace adds no second notification but opens the run', async () => {
  const sessionId = 'native-wake-1';
  const pushed = [];
  __setNativeWakeGraceMs(150);
  __setClaudeQueryImpl(makeScriptedQuery([
    launchBackground('launching background poll', sessionId),
    taskStarted('t1', sessionId),
    resultMsg(sessionId),
    () => delay(20),
    notification(sessionId, { task_id: 't1', tool_use_id: 'toolu_1' }),
    // The runtime's own wake: a fresh init, then the resumed turn.
    { type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-opus-5-5' },
    assistantText('woken by the runtime', sessionId),
    resultMsg(sessionId),
  ], pushed));
  const resumeWriter = makeRecordingWriter();
  let acquired = 0;
  const writer = makeRecordingWriter();

  try {
    await queryClaudeSDK('watch the host', {
      sessionId, ephemeral: false,
      acquireResumeRun: () => { acquired += 1; return resumeWriter; },
    }, writer);
    await resumeWriter.waitFor((msgs) => msgs.some((m) => m.kind === 'complete'), 'resumed turn settles');
    assert.ok(resumeWriter.messages.some((m) => JSON.stringify(m).includes('woken by the runtime')),
      'the runtime-started turn streams under its own run');
    assert.equal(acquired, 1, 'exactly one resume run');
    await delay(250); // past the grace window
    assert.deepEqual(pushed, [], 'nothing was pushed on top of the runtime\'s own notification');
  } finally {
    __setNativeWakeGraceMs(0);
    await abortClaudeSDKSession(sessionId).catch(() => {});
    __setClaudeQueryImpl(null);
  }
});

test("a subagent's own background task never wakes the parent", async () => {
  const sessionId = 'child-task-1';
  const pushed = [];
  __setClaudeQueryImpl(makeScriptedQuery([
    launchBackground('launching an agent', sessionId), // main thread: toolu_1
    // The subagent's own Bash call streams with parent_tool_use_id set.
    {
      type: 'assistant', session_id: sessionId, parent_tool_use_id: 'toolu_1',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_child', name: 'Bash', input: { command: 'make test' } }] },
    },
    resultMsg(sessionId),
    () => delay(20),
    notification(sessionId, { task_id: 'bchild', tool_use_id: 'toolu_child', summary: 'make test' }),
    notification(sessionId, { task_id: 'bunknown', tool_use_id: 'toolu_never_seen' }),
  ], pushed));
  const writer = makeRecordingWriter();

  try {
    await queryClaudeSDK('delegate the tests', { sessionId, ephemeral: false }, writer);
    await delay(80);
    assert.deepEqual(pushed, [], 'no notification was forwarded to the parent');
    assert.equal(isClaudeSDKSessionActive(sessionId), false, 'the parent stays idle');
  } finally {
    await abortClaudeSDKSession(sessionId).catch(() => {});
    __setClaudeQueryImpl(null);
  }
});

test('a repeated task_notification for the same (task id, tool-use id) is delivered once', async () => {
  const sessionId = 'dup-notification-1';
  const pushed = [];
  __setClaudeQueryImpl(makeScriptedQuery([
    launchBackground('launching background poll', sessionId),
    taskStarted('t1', sessionId),
    resultMsg(sessionId),
    () => delay(20),
    notification(sessionId, { task_id: 't1', tool_use_id: 'toolu_1' }),
    notification(sessionId, { task_id: 't1', tool_use_id: 'toolu_1' }),
    () => delay(40),
    assistantText('resumed', sessionId),
    resultMsg(sessionId),
    () => delay(20),
    notification(sessionId, { task_id: 't1', tool_use_id: 'toolu_1' }),
  ], pushed));
  const writer = makeRecordingWriter();

  try {
    await queryClaudeSDK('watch the host', { sessionId, ephemeral: false }, writer);
    await delay(150);
    assert.equal(pushed.length, 1, 'one delivery for one completion');
    assert.match(pushed[0].message.content, /<task-id>t1<\/task-id>/);
    assert.match(pushed[0].message.content, /<tool-use-id>toolu_1<\/tool-use-id>/);
  } finally {
    await abortClaudeSDKSession(sessionId).catch(() => {});
    __setClaudeQueryImpl(null);
  }
});

test('a task that is started again may notify again (an agent resumed with SendMessage)', async () => {
  const sessionId = 'renotify-1';
  const pushed = [];
  __setClaudeQueryImpl(makeScriptedQuery([
    launchBackground('launching an agent', sessionId),
    taskStarted('a1', sessionId),
    resultMsg(sessionId),
    () => delay(20),
    notification(sessionId, { task_id: 'a1', tool_use_id: 'toolu_1', summary: 'first report' }),
    () => delay(40),
    assistantText('asking it for more', sessionId),
    taskStarted('a1', sessionId),
    resultMsg(sessionId),
    () => delay(20),
    notification(sessionId, { task_id: 'a1', tool_use_id: 'toolu_1', summary: 'second report' }),
  ], pushed));
  const writer = makeRecordingWriter();

  try {
    await queryClaudeSDK('delegate', { sessionId, ephemeral: false }, writer);
    await delay(200);
    assert.equal(pushed.length, 2);
    assert.match(pushed[1].message.content, /second report/);
  } finally {
    await abortClaudeSDKSession(sessionId).catch(() => {});
    __setClaudeQueryImpl(null);
  }
});

test('a stopped task does not wake the agent', async () => {
  const sessionId = 'stopped-task-1';
  const pushed = [];
  __setClaudeQueryImpl(makeScriptedQuery([
    launchBackground('launching a monitor', sessionId),
    taskStarted('t1', sessionId),
    resultMsg(sessionId),
    () => delay(20),
    notification(sessionId, { task_id: 't1', tool_use_id: 'toolu_1', status: 'stopped' }),
  ], pushed));
  const writer = makeRecordingWriter();

  try {
    await queryClaudeSDK('watch the host', { sessionId, ephemeral: false }, writer);
    await delay(80);
    assert.deepEqual(pushed, []);
    assert.equal(isClaudeSDKSessionActive(sessionId), false);
  } finally {
    await abortClaudeSDKSession(sessionId).catch(() => {});
    __setClaudeQueryImpl(null);
  }
});
