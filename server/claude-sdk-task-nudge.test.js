import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Same timing contract as the idle-reaper suite: short enough to fire inside a
// test, long enough that scheduling jitter doesn't trip it. Set before the
// import — the module reads these into consts at load time.
process.env.CLAUDE_SESSION_IDLE_TIMEOUT_MS = '80';
process.env.CLAUDE_ABORT_MIN_TURN_AGE_MS = '0';
process.env.VIBESPACE_TASK_NUDGE_MAX = '3';

// Point the task-ledger reader at a throwaway config dir (read at call time).
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibespace-task-nudge-'));
process.env.CLAUDE_CONFIG_DIR = configDir;

const {
  queryClaudeSDK,
  abortClaudeSDKSession,
  isClaudeSDKSessionAlive,
  __setClaudeQueryImpl,
} = await import('./claude-sdk.js');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(predicate, label, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(20);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

function makeRecordingWriter() {
  const messages = [];
  return {
    userId: null,
    isWebSocketWriter: true,
    ws: { readyState: 1, send() {} },
    setSessionId() {},
    send(msg) { messages.push(msg); },
    messages,
  };
}

function writeTask(sessionId, id, status, subject = `task ${id}`) {
  const dir = path.join(configDir, 'tasks', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({ id: String(id), subject, description: subject, status, blocks: [], blockedBy: [] }),
  );
}

const assistantText = (text, sessionId) => ({
  type: 'assistant',
  session_id: sessionId,
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});
const assistantTool = (name, sessionId) => ({
  type: 'assistant',
  session_id: sessionId,
  message: { role: 'assistant', content: [{ type: 'tool_use', id: `tu-${Date.now()}`, name, input: {} }] },
});
const resultMsg = (sessionId) => ({ type: 'result', subtype: 'success', session_id: sessionId });

/**
 * A scripted runtime that answers every incoming user message with
 * `respond(text, index)` yields and records what it received. Ends when the
 * input stream closes (which endSession does).
 */
function scriptedRuntime(sessionId, respond, received) {
  return ({ prompt }) => {
    const reader = prompt[Symbol.asyncIterator]();
    const gen = (async function* () {
      for (let i = 0; ; i += 1) {
        const { value, done } = await reader.next();
        if (done) return;
        received.push(JSON.stringify(value));
        yield* respond(i);
        yield resultMsg(sessionId);
      }
    })();
    gen.interrupt = async () => {};
    gen.setModel = async () => {};
    gen.setPermissionMode = async () => {};
    return gen;
  };
}

const isNudge = (raw) => raw.includes('[session supervisor]');

// The core promise: an idle turn boundary is not the end of a session whose
// ledger still has open items — the reaper injects a continuation turn instead
// of tearing the session down, and closing the ledger is what ends the loop.
test('an idle session with an open task is nudged, and reaped once the ledger closes', async () => {
  const sessionId = 'nudge-continue-1';
  writeTask(sessionId, 1, 'completed', 'already done');
  writeTask(sessionId, 2, 'pending', 'still open');

  const received = [];
  const respond = function* (i) {
    yield assistantText(`turn ${i}`, sessionId);
  };
  __setClaudeQueryImpl(scriptedRuntime(sessionId, respond, received));

  try {
    await queryClaudeSDK('start', { sessionId, ephemeral: false }, makeRecordingWriter());

    await waitUntil(() => received.some(isNudge), 'the nudge to arrive');
    assert.equal(isClaudeSDKSessionAlive(sessionId), true, 'session must survive the idle window');
    const nudge = received.find(isNudge);
    assert.ok(nudge.includes('still open'), 'nudge lists the open task');
    assert.ok(!nudge.includes('already done'), 'closed tasks are not listed');

    // The model "finishes": the ledger closes, so the next idle window reaps.
    writeTask(sessionId, 2, 'completed', 'still open');
    await waitUntil(() => !isClaudeSDKSessionAlive(sessionId), 'the session to be reaped');
  } finally {
    await abortClaudeSDKSession(sessionId).catch(() => {});
    __setClaudeQueryImpl(null);
  }
});

// A nudge that produces no tool calls and leaves the ledger untouched did
// nothing; two of those in a row must end the loop — otherwise a confused
// model burns tokens all night answering its own reminders.
test('two no-progress nudges give up instead of looping forever', async () => {
  const sessionId = 'nudge-stall-1';
  writeTask(sessionId, 1, 'in_progress', 'never advanced');

  const received = [];
  // Text only — no tool_use, and the ledger never changes.
  const respond = function* (i) {
    yield assistantText(`shrug ${i}`, sessionId);
  };
  __setClaudeQueryImpl(scriptedRuntime(sessionId, respond, received));

  try {
    await queryClaudeSDK('start', { sessionId, ephemeral: false }, makeRecordingWriter());
    await waitUntil(() => !isClaudeSDKSessionAlive(sessionId), 'the session to give up', 5000);
    assert.equal(received.filter(isNudge).length, 2, 'exactly two nudges before the stall detector trips');
  } finally {
    await abortClaudeSDKSession(sessionId).catch(() => {});
    __setClaudeQueryImpl(null);
  }
});

// Real work (tool calls) resets the stall detector but not the budget: a model
// that keeps working without ever closing its ledger is bounded by
// VIBESPACE_TASK_NUDGE_MAX, not trusted indefinitely.
test('a working-but-never-closing session is bounded by the nudge budget', async () => {
  const sessionId = 'nudge-budget-1';
  writeTask(sessionId, 1, 'pending', 'sisyphus');

  const received = [];
  // Every turn does tool work, so the stall detector never trips…
  const respond = function* (i) {
    yield assistantTool('Bash', sessionId);
    yield assistantText(`working ${i}`, sessionId);
  };
  __setClaudeQueryImpl(scriptedRuntime(sessionId, respond, received));

  try {
    await queryClaudeSDK('start', { sessionId, ephemeral: false }, makeRecordingWriter());
    await waitUntil(() => !isClaudeSDKSessionAlive(sessionId), 'the budget to run out', 5000);
    // …but the budget (3, set at the top of this file) still bounds the loop.
    assert.equal(received.filter(isNudge).length, 3, 'exactly VIBESPACE_TASK_NUDGE_MAX nudges');
  } finally {
    await abortClaudeSDKSession(sessionId).catch(() => {});
    __setClaudeQueryImpl(null);
  }
});

// A session with no ledger at all keeps today's behavior: idle → reap, no
// nudges, no extra turns.
test('a session with no task ledger is reaped exactly as before', async () => {
  const sessionId = 'nudge-none-1';

  const received = [];
  const respond = function* (i) {
    yield assistantText(`turn ${i}`, sessionId);
  };
  __setClaudeQueryImpl(scriptedRuntime(sessionId, respond, received));

  try {
    await queryClaudeSDK('start', { sessionId, ephemeral: false }, makeRecordingWriter());
    await waitUntil(() => !isClaudeSDKSessionAlive(sessionId), 'the ordinary idle reap');
    assert.equal(received.filter(isNudge).length, 0, 'no nudges without a ledger');
  } finally {
    await abortClaudeSDKSession(sessionId).catch(() => {});
    __setClaudeQueryImpl(null);
  }
});
