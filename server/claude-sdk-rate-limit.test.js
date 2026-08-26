import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Short idle window so the reaper fires inside the test (module reads these at
// load time); throwaway dirs for the task ledger and the wake registry.
process.env.CLAUDE_SESSION_IDLE_TIMEOUT_MS = '80';
process.env.CLAUDE_ABORT_MIN_TURN_AGE_MS = '0';
process.env.VIBESPACE_TASK_NUDGE_MAX = '3';
process.env.VIBESPACE_CLAUDE_529_RETRY_MS = '300000';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vibespace-rate-limit-'));
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
process.env.DATABASE_PATH = path.join(tmp, 'data', 'auth.db');

const {
  queryClaudeSDK,
  abortClaudeSDKSession,
  isClaudeSDKSessionAlive,
  __setClaudeQueryImpl,
} = await import('./claude-sdk.js');
const {
  isRateLimitWakePending,
  getRateLimitWake,
  __resetRateLimitWakeState,
} = await import('./services/rate-limit-wake.service.js');

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
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'tasks', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({ id: String(id), subject, description: subject, status, blocks: [], blockedBy: [] }),
  );
}

const LIMIT_TEXT = "You've hit your session limit · resets 7:30pm (Europe/Moscow)";

// The shape the runtime writes for a rejected request — see the transcript
// line this was lifted from: a synthetic assistant message flagged
// `error: 'rate_limit'`, with the machine-readable quota alongside.
const limitMessage = (sessionId, resetsAtSec) => ({
  type: 'assistant',
  session_id: sessionId,
  error: 'rate_limit',
  isApiErrorMessage: true,
  apiErrorStatus: 429,
  quotaLimits: { status: 'rejected', resetsAt: resetsAtSec, rateLimitType: 'five_hour' },
  message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: LIMIT_TEXT }] },
});
const rateLimitEvent = (sessionId, resetsAtSec) => ({
  type: 'rate_limit_event',
  session_id: sessionId,
  rate_limit_info: { status: 'rejected', resetsAt: resetsAtSec, rateLimitType: 'five_hour' },
});
const overloadMessage = (sessionId) => ({
  type: 'assistant',
  session_id: sessionId,
  error: 'api_error',
  isApiErrorMessage: true,
  apiErrorStatus: 529,
  message: {
    role: 'assistant',
    model: '<synthetic>',
    content: [{ type: 'text', text: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}' }],
  },
});
const assistantText = (text, sessionId) => ({
  type: 'assistant',
  session_id: sessionId,
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});
const resultMsg = (sessionId) => ({ type: 'result', subtype: 'success', session_id: sessionId });

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

// A turn the usage limit kills schedules its own wake, and the idle reaper —
// which would otherwise nudge the open ledger every idle window straight back
// into the limit — stands down and lets the session go.
test('a usage-limited turn schedules a wake and is not nudged while it waits', async () => {
  __resetRateLimitWakeState();
  const sessionId = 'rate-limit-1';
  writeTask(sessionId, 1, 'in_progress', 'deploy the thing');
  const resetsAtSec = Math.floor(Date.now() / 1000) + 3600;

  const received = [];
  const respond = function* () {
    yield rateLimitEvent(sessionId, resetsAtSec);
    yield limitMessage(sessionId, resetsAtSec);
  };
  __setClaudeQueryImpl(scriptedRuntime(sessionId, respond, received));
  const writer = makeRecordingWriter();

  try {
    await queryClaudeSDK('keep going', { sessionId, ephemeral: false, permissionMode: 'bypassPermissions' }, writer);

    // The turn itself settles normally for the client.
    assert.ok(writer.messages.some((m) => m.kind === 'complete' && m.exitCode === 0), 'turn completes');

    await waitUntil(() => isRateLimitWakePending(sessionId), 'the wake to be scheduled');
    const wake = getRateLimitWake(sessionId);
    assert.equal(wake.provider, 'claude');
    assert.equal(wake.resetsAt, resetsAtSec * 1000, 'reset comes from the quota payload');
    assert.equal(wake.limitType, 'five_hour');
    assert.equal(wake.limitText, LIMIT_TEXT);
    assert.equal(wake.permissionMode, 'bypassPermissions');
    assert.ok(wake.resumeAt > wake.resetsAt, 'resume waits out the grace after the reset');

    // Idle reaper: open ledger, but no nudge — the session is torn down.
    await waitUntil(() => !isClaudeSDKSessionAlive(sessionId), 'the session to be reaped', 4000);
    assert.equal(received.filter(isNudge).length, 0, 'no nudge was injected into a rate-limited session');
    assert.equal(isRateLimitWakePending(sessionId), true, 'the wake survives the teardown');
  } finally {
    await abortClaudeSDKSession(sessionId).catch(() => {});
    __setClaudeQueryImpl(null);
  }
});

// The reset can arrive only through the rate_limit_event (the assistant
// message's quota payload is a transcript-side extra the SDK may not forward).
test('the reset time falls back to the rate_limit_event when the assistant message has none', async () => {
  __resetRateLimitWakeState();
  const sessionId = 'rate-limit-2';
  const resetsAtSec = Math.floor(Date.now() / 1000) + 1800;

  const received = [];
  const respond = function* () {
    const msg = limitMessage(sessionId, resetsAtSec);
    delete msg.quotaLimits;
    yield msg;
    yield rateLimitEvent(sessionId, resetsAtSec);
  };
  __setClaudeQueryImpl(scriptedRuntime(sessionId, respond, received));

  try {
    await queryClaudeSDK('go', { sessionId, ephemeral: false }, makeRecordingWriter());
    await waitUntil(() => isRateLimitWakePending(sessionId), 'the wake to be scheduled');
    assert.equal(getRateLimitWake(sessionId).resetsAt, resetsAtSec * 1000);
  } finally {
    await abortClaudeSDKSession(sessionId).catch(() => {});
    __setClaudeQueryImpl(null);
  }
});

test('a Claude HTTP 529 turn schedules the fixed retry and preserves one incident identity', async () => {
  __resetRateLimitWakeState();
  const sessionId = 'overloaded-529';
  const received = [];
  __setClaudeQueryImpl(scriptedRuntime(sessionId, function* () {
    yield overloadMessage(sessionId);
  }, received));

  try {
    await queryClaudeSDK('automatic retry', {
      sessionId,
      ephemeral: false,
      rateLimitWakeMessageId: 'incident-529',
      rateLimitWakeAttempts: 7,
    }, makeRecordingWriter());
    await waitUntil(() => isRateLimitWakePending(sessionId), 'the 529 wake to be scheduled');
    const wake = getRateLimitWake(sessionId);
    assert.equal(wake.recoveryKind, 'claude-529');
    assert.equal(wake.limitType, 'http_529');
    assert.equal(wake.attempts, 8);
    assert.equal(wake.messageId, 'incident-529');
    assert.equal(wake.resumeAt - wake.recordedAt, 300_000);
  } finally {
    await abortClaudeSDKSession(sessionId).catch(() => {});
    __setClaudeQueryImpl(null);
  }
});

test('a thrown Claude HTTP 529 error enters the same durable retry loop', async () => {
  __resetRateLimitWakeState();
  const sessionId = 'overloaded-529-thrown';
  __setClaudeQueryImpl(({ prompt }) => {
    const generator = (async function* () {
      await prompt[Symbol.asyncIterator]().next();
      const error = new Error('Claude API failed with HTTP 529: service overloaded');
      error.status = 529;
      throw error;
    })();
    generator.interrupt = async () => {};
    generator.setModel = async () => {};
    generator.setPermissionMode = async () => {};
    return generator;
  });

  try {
    await queryClaudeSDK('continue', { sessionId, ephemeral: false }, makeRecordingWriter());
    await waitUntil(() => isRateLimitWakePending(sessionId), 'the thrown 529 wake to be scheduled');
    const wake = getRateLimitWake(sessionId);
    assert.equal(wake.recoveryKind, 'claude-529');
    assert.equal(wake.attempts, 1);
    assert.equal(wake.resumeAt - wake.recordedAt, 300_000);
  } finally {
    await abortClaudeSDKSession(sessionId).catch(() => {});
    __setClaudeQueryImpl(null);
  }
});

// An ordinary successful turn must leave no wake behind, and a new turn on a
// session with a pending wake cancels it (the user took over).
test('a normal turn schedules nothing, and a fresh turn cancels a pending wake', async () => {
  __resetRateLimitWakeState();
  const sessionId = 'rate-limit-3';
  const resetsAtSec = Math.floor(Date.now() / 1000) + 3600;

  const received = [];
  let limited = true;
  const respond = function* (i) {
    if (limited && i === 0) {
      yield limitMessage(sessionId, resetsAtSec);
    } else {
      yield assistantText(`fine ${i}`, sessionId);
    }
  };
  __setClaudeQueryImpl(scriptedRuntime(sessionId, respond, received));

  try {
    await queryClaudeSDK('first', { sessionId, ephemeral: false }, makeRecordingWriter());
    await waitUntil(() => isRateLimitWakePending(sessionId), 'the wake to be scheduled');

    limited = false;
    await queryClaudeSDK('second', { sessionId, ephemeral: false }, makeRecordingWriter());
    await waitUntil(() => !isRateLimitWakePending(sessionId), 'the wake to be cancelled by the new turn');
    assert.equal(isRateLimitWakePending(sessionId), false);
  } finally {
    await abortClaudeSDKSession(sessionId).catch(() => {});
    __setClaudeQueryImpl(null);
  }

  // Ephemeral helpers never schedule wakes.
  __resetRateLimitWakeState();
  const helperId = 'rate-limit-ephemeral';
  __setClaudeQueryImpl(scriptedRuntime(helperId, function* () { yield limitMessage(helperId, resetsAtSec); }, []));
  try {
    await queryClaudeSDK('summarize', { sessionId: helperId, ephemeral: true }, makeRecordingWriter());
    await delay(100);
    assert.equal(isRateLimitWakePending(helperId), false, 'ephemeral sessions are not woken');
  } finally {
    await abortClaudeSDKSession(helperId).catch(() => {});
    __setClaudeQueryImpl(null);
  }
});
