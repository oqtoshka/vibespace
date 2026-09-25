import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.CLAUDE_SESSION_IDLE_TIMEOUT_MS = '80';
process.env.CLAUDE_ABORT_MIN_TURN_AGE_MS = '0';
process.env.VIBESPACE_TASK_NUDGE_MAX = '3';

const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibespace-model-switch-'));
process.env.CLAUDE_CONFIG_DIR = configDir;
// The model-override store lives under the home dir; keep the suite off the
// developer's real one. Set before the import so every path helper sees it.
const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibespace-model-home-'));
process.env.HOME = homeDir;

const {
  queryClaudeSDK, abortClaudeSDKSession, isClaudeSDKSessionAlive, __setClaudeQueryImpl,
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
  return {
    userId: null,
    isWebSocketWriter: true,
    ws: { readyState: 1, send() {} },
    setSessionId() {},
    send() {},
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

/** The user's model pick, as the picker endpoint persists it. */
function writeModelOverride(sessionId, model) {
  const file = path.join(homeDir, '.vibespace', 'provider-session-active-model-changes.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    entries: {
      [`claude:${sessionId}`]: {
        provider: 'claude',
        sessionId,
        supported: true,
        changed: true,
        model,
        updatedAt: new Date().toISOString(),
      },
    },
  }));
}

const initMsg = (sessionId, model) => ({
  type: 'system',
  subtype: 'init',
  session_id: sessionId,
  model,
  capabilities: ['msg_lifecycle_v1'],
});
const assistantText = (text, sessionId) => ({
  type: 'assistant',
  session_id: sessionId,
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});
const resultMsg = (sessionId) => ({ type: 'result', subtype: 'success', session_id: sessionId });

/**
 * A runtime that announces the model it is really running (as the CLI does on
 * every turn's `init`) and records every setModel it is asked for.
 */
function scriptedRuntime(sessionId, runtimeModel, received, setModelCalls) {
  return ({ prompt }) => {
    const reader = prompt[Symbol.asyncIterator]();
    const gen = (async function* () {
      for (let i = 0; ; i += 1) {
        const { value, done } = await reader.next();
        if (done) return;
        received.push(JSON.stringify(value));
        yield initMsg(sessionId, runtimeModel.value);
        yield assistantText(`turn ${i}`, sessionId);
        yield resultMsg(sessionId);
      }
    })();
    gen.interrupt = async () => {};
    gen.setModel = async (model) => {
      setModelCalls.push(model);
      runtimeModel.value = model === undefined ? runtimeModel.value : `claude-${model}-5`;
    };
    gen.setPermissionMode = async () => {};
    return gen;
  };
}

// The bug this guards: a turn the *server* starts (background-job auto-resume,
// the open-tasks nudge) used to skip the model reconciliation entirely, so a
// session that kept itself going never picked up the model the user chose.
test('a server-started continuation turn applies the pending model override', async () => {
  const sessionId = 'model-switch-nudge';
  writeTask(sessionId, 1, 'pending', 'still open');
  writeModelOverride(sessionId, 'opus');

  const received = [];
  const setModelCalls = [];
  const runtimeModel = { value: 'claude-fable-5' };
  __setClaudeQueryImpl(scriptedRuntime(sessionId, runtimeModel, received, setModelCalls));

  try {
    await queryClaudeSDK('start', { sessionId, ephemeral: false }, makeRecordingWriter());
    await waitUntil(
      () => received.some((raw) => raw.includes('[session supervisor]')),
      'the open-tasks nudge to arrive',
    );
    assert.ok(setModelCalls.includes('opus'), `expected a switch to opus, got ${JSON.stringify(setModelCalls)}`);
  } finally {
    writeTask(sessionId, 1, 'completed', 'still open');
    await abortClaudeSDKSession(sessionId).catch(() => {});
    __setClaudeQueryImpl(null);
  }
});

// The bug this guards: a resumed session is deliberately started without a
// `--model` flag so it keeps the model it already ran on, but vibespace still
// recorded the *requested* model on the session. The mid-session switch then
// compared the user's pick against that fiction, decided it was already
// applied, and left the runtime on the old model for good.
test('a pick that matches the requested-but-never-applied model still switches the runtime', async () => {
  const sessionId = 'model-switch-resumed';
  const overrides = path.join(homeDir, '.vibespace', 'provider-session-active-model-changes.json');
  fs.rmSync(overrides, { force: true });

  const received = [];
  const setModelCalls = [];
  // The conversation is really on Fable; the composer merely rides 'opus' along
  // as its per-provider default.
  const runtimeModel = { value: 'claude-fable-5' };
  __setClaudeQueryImpl(scriptedRuntime(sessionId, runtimeModel, received, setModelCalls));

  try {
    await queryClaudeSDK('start', { sessionId, resume: true, model: 'opus', ephemeral: false }, makeRecordingWriter());
    assert.deepEqual(setModelCalls, [], 'a resume must not move the session on its own');

    // Now the user actually picks Opus.
    writeModelOverride(sessionId, 'opus');
    await queryClaudeSDK('next', { sessionId, resume: true, model: 'opus', ephemeral: false }, makeRecordingWriter());
    assert.deepEqual(setModelCalls, ['opus'], 'the pick must reach the runtime');
  } finally {
    await abortClaudeSDKSession(sessionId).catch(() => {});
    __setClaudeQueryImpl(null);
  }
});

function clearModelOverrides() {
  fs.rmSync(path.join(homeDir, '.vibespace', 'provider-session-active-model-changes.json'), { force: true });
}

// The bug this guards: a stored "Default (recommended)" pick is already in
// effect the moment a live instance starts (no `--model` flag), but the session
// object did not remember that, and `init` reports the concrete model — so the
// first turn of every new instance (idle resume, server restart) re-applied it
// as `setModel(undefined)`, which the SDK writes into the transcript as a user
// `/model default` + "Set model to …" pair the chat then shows.
test('a Default pick already in effect is never re-applied by a new live instance', async () => {
  const sessionId = 'model-switch-default-in-effect';
  clearModelOverrides();
  writeModelOverride(sessionId, 'default');

  const received = [];
  const setModelCalls = [];
  const runtimeModel = { value: 'claude-opus-5-5' };
  const starts = [];
  const runtime = scriptedRuntime(sessionId, runtimeModel, received, setModelCalls);
  __setClaudeQueryImpl((args) => { starts.push(args.options?.model); return runtime(args); });

  try {
    // Two consecutive live instances of the same conversation, as after an idle
    // reap or a restart; each takes a follow-up turn.
    for (let instance = 0; instance < 2; instance += 1) {
      await queryClaudeSDK('resume', { sessionId, resume: true, ephemeral: false }, makeRecordingWriter());
      await queryClaudeSDK('next', { sessionId, resume: true, ephemeral: false }, makeRecordingWriter());
      // Let the idle reaper close this instance, so the next pass starts a new one.
      await waitUntil(() => !isClaudeSDKSessionAlive(sessionId), 'the idle reaper to close the instance');
    }
    assert.equal(starts.length, 2, 'each pass must run in its own live instance');
    assert.deepEqual(setModelCalls, [], 'the default in effect must not be pushed again');
  } finally {
    await abortClaudeSDKSession(sessionId).catch(() => {});
    __setClaudeQueryImpl(null);
  }
});

test('an explicit pick made mid-session on a Default session still switches the model', async () => {
  const sessionId = 'model-switch-default-then-pick';
  clearModelOverrides();
  writeModelOverride(sessionId, 'default');

  const received = [];
  const setModelCalls = [];
  const runtimeModel = { value: 'claude-opus-5-5' };
  __setClaudeQueryImpl(scriptedRuntime(sessionId, runtimeModel, received, setModelCalls));

  try {
    await queryClaudeSDK('resume', { sessionId, resume: true, ephemeral: false }, makeRecordingWriter());
    writeModelOverride(sessionId, 'fable');
    await queryClaudeSDK('next', { sessionId, resume: true, ephemeral: false }, makeRecordingWriter());
    await queryClaudeSDK('again', { sessionId, resume: true, ephemeral: false }, makeRecordingWriter());
    assert.deepEqual(setModelCalls, ['fable'], 'the pick must reach the runtime exactly once');
  } finally {
    await abortClaudeSDKSession(sessionId).catch(() => {});
    __setClaudeQueryImpl(null);
  }
});

test('switching from an explicit pick back to Default applies once', async () => {
  const sessionId = 'model-switch-pick-then-default';
  clearModelOverrides();
  writeModelOverride(sessionId, 'fable');

  const received = [];
  const setModelCalls = [];
  // Launched with `--model fable`, so the runtime reports Fable.
  const runtimeModel = { value: 'claude-fable-5' };
  __setClaudeQueryImpl(scriptedRuntime(sessionId, runtimeModel, received, setModelCalls));

  try {
    await queryClaudeSDK('resume', { sessionId, resume: true, ephemeral: false }, makeRecordingWriter());
    await queryClaudeSDK('next', { sessionId, resume: true, ephemeral: false }, makeRecordingWriter());
    assert.deepEqual(setModelCalls, [], 'the pick in effect must not be re-applied');

    writeModelOverride(sessionId, 'default');
    await queryClaudeSDK('back to default', { sessionId, resume: true, ephemeral: false }, makeRecordingWriter());
    await queryClaudeSDK('again', { sessionId, resume: true, ephemeral: false }, makeRecordingWriter());
    assert.deepEqual(setModelCalls, [undefined], 'Default must be applied exactly once');
  } finally {
    await abortClaudeSDKSession(sessionId).catch(() => {});
    __setClaudeQueryImpl(null);
  }
});

test('a concrete pick the CLI reset across a compaction is re-applied', async () => {
  const sessionId = 'model-switch-compaction-reset';
  clearModelOverrides();
  writeModelOverride(sessionId, 'fable');

  const received = [];
  const setModelCalls = [];
  const runtimeModel = { value: 'claude-fable-5' };
  __setClaudeQueryImpl(scriptedRuntime(sessionId, runtimeModel, received, setModelCalls));

  try {
    await queryClaudeSDK('resume', { sessionId, resume: true, ephemeral: false }, makeRecordingWriter());
    // A compaction drops the runtime back onto another model; the next `init`
    // says so.
    runtimeModel.value = 'claude-opus-5-5';
    await queryClaudeSDK('after compaction', { sessionId, resume: true, ephemeral: false }, makeRecordingWriter());
    await queryClaudeSDK('next', { sessionId, resume: true, ephemeral: false }, makeRecordingWriter());
    assert.deepEqual(setModelCalls, ['fable'], 'the pick must be re-applied after the reset');
  } finally {
    await abortClaudeSDKSession(sessionId).catch(() => {});
    __setClaudeQueryImpl(null);
  }
});
