import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'codex-rate-limit-'));
process.env.DATABASE_PATH = path.join(tmp, 'data', 'auth.db');

const { queryCodex, isCodexUsageLimitError, pickCodexLimitReset, __resetCodexRateLimits } = await import('./openai-codex.js');
const { stopCodexAppServer } = await import('./services/codex-app-server.service.js');
const {
  isRateLimitWakePending,
  getRateLimitWake,
  __resetRateLimitWakeState,
} = await import('./services/rate-limit-wake.service.js');

/**
 * A fake app-server whose every turn fails on the usage limit. It narrates
 * the limit the way the real one does: a sparse `account/rateLimits/updated`
 * before the turn fails, `turn/completed` with status `failed` and
 * `codexErrorInfo: 'usageLimitExceeded'`, and answers
 * `account/rateLimits/read` with the full snapshot.
 */
async function createFakeCodex(scriptPath, { resetsAt, announceBeforeFail }) {
  await writeFile(scriptPath, `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const capturePath = process.env.VIBESPACE_CODEX_CAPTURE;
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const record = (value) => fs.appendFileSync(capturePath, JSON.stringify(value) + '\\n');
const snapshot = {
  primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: ${resetsAt} },
  secondary: { usedPercent: 41, windowDurationMins: 10080, resetsAt: ${resetsAt + 5 * 86400} },
  planType: 'plus',
};
let turnCounter = 0;

rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method) record(message);
  switch (message.method) {
    case 'initialize':
      send({ id: message.id, result: { userAgent: 'fake' } });
      break;
    case 'thread/start':
      send({ id: message.id, result: { thread: { id: 'codex-limited-1' } } });
      break;
    case 'thread/resume':
      send({ id: message.id, result: { thread: { id: message.params.threadId } } });
      break;
    case 'account/rateLimits/read':
      send({ id: message.id, result: { rateLimits: snapshot } });
      break;
    case 'turn/start': {
      const turnId = 'turn-' + (++turnCounter);
      send({ id: message.id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } });
      send({ method: 'turn/started', params: {
        threadId: message.params.threadId,
        turn: { id: turnId, status: 'inProgress', items: [] },
      } });
      if (${announceBeforeFail ? 'true' : 'false'}) {
        send({ method: 'account/rateLimits/updated', params: { rateLimits: { primary: snapshot.primary } } });
      }
      send({ method: 'turn/completed', params: {
        threadId: message.params.threadId,
        turn: {
          id: turnId,
          status: 'failed',
          items: [],
          error: {
            message: "You've hit your usage limit. Try again in 1 hour 30 minutes.",
            codexErrorInfo: 'usageLimitExceeded',
          },
        },
      } });
      break;
    }
  }
});
`, 'utf8');
  await chmod(scriptPath, 0o755);
}

function makeWriter() {
  const messages = [];
  return {
    isWebSocketWriter: true,
    userId: 3,
    send(message) { messages.push(message); },
    setSessionId() {},
    messages,
  };
}

async function withFakeCodex(opts, run) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-limit-run-'));
  const executable = path.join(tempRoot, 'fake-codex');
  const capturePath = path.join(tempRoot, 'requests.jsonl');
  const previousPath = process.env.VIBESPACE_CODEX_PATH;
  const previousCapture = process.env.VIBESPACE_CODEX_CAPTURE;
  try {
    await createFakeCodex(executable, opts);
    process.env.VIBESPACE_CODEX_PATH = executable;
    process.env.VIBESPACE_CODEX_CAPTURE = capturePath;
    __resetRateLimitWakeState();
    __resetCodexRateLimits();
    await run({ tempRoot, capturePath });
  } finally {
    stopCodexAppServer();
    if (previousPath === undefined) delete process.env.VIBESPACE_CODEX_PATH;
    else process.env.VIBESPACE_CODEX_PATH = previousPath;
    if (previousCapture === undefined) delete process.env.VIBESPACE_CODEX_CAPTURE;
    else process.env.VIBESPACE_CODEX_CAPTURE = previousCapture;
    await rm(tempRoot, { recursive: true, force: true });
  }
}

test('isCodexUsageLimitError recognizes the app-server error shapes', () => {
  assert.equal(isCodexUsageLimitError({ message: 'x', codexErrorInfo: 'usageLimitExceeded' }), true);
  assert.equal(isCodexUsageLimitError({ message: 'x', codexErrorInfo: { usageLimitExceeded: {} } }), true);
  assert.equal(isCodexUsageLimitError({ message: "You've hit your usage limit." }), true);
  assert.equal(isCodexUsageLimitError({ message: 'sandbox denied', codexErrorInfo: 'sandboxError' }), false);
  assert.equal(isCodexUsageLimitError(new Error('Codex turn failed')), false);
  assert.equal(isCodexUsageLimitError(null), false);
});

test('pickCodexLimitReset gates on the latest exhausted window', () => {
  assert.equal(pickCodexLimitReset({
    primary: { usedPercent: 100, resetsAt: 100 },
    secondary: { usedPercent: 100, resetsAt: 900 },
  }), 900);
  assert.equal(pickCodexLimitReset({
    primary: { usedPercent: 100, resetsAt: 100 },
    secondary: { usedPercent: 40, resetsAt: 900 },
  }), 100);
  // Nothing reads as exhausted (a stale snapshot): the busiest window is the best guess.
  assert.equal(pickCodexLimitReset({
    primary: { usedPercent: 97, resetsAt: 100 },
    secondary: { usedPercent: 40, resetsAt: 900 },
  }), 100);
  assert.equal(pickCodexLimitReset({ primary: { usedPercent: 100 } }), null);
  assert.equal(pickCodexLimitReset(null), null);
});

test('a Codex turn that fails on the usage limit schedules a wake from the live rate-limit snapshot', async () => {
  const resetsAt = Math.floor(Date.now() / 1000) + 5400;
  await withFakeCodex({ resetsAt, announceBeforeFail: true }, async ({ tempRoot, capturePath }) => {
    const writer = makeWriter();
    await queryCodex('Do the thing', {
      cwd: tempRoot,
      sessionId: 'codex-limited-1',
      sessionSummary: 'Limited job',
      model: 'gpt-5.4',
      permissionMode: 'bypassPermissions',
    }, writer);

    assert.equal(isRateLimitWakePending('codex-limited-1'), true);
    const wake = getRateLimitWake('codex-limited-1');
    assert.equal(wake.provider, 'codex');
    assert.equal(wake.userId, 3);
    assert.equal(wake.sessionName, 'Limited job');
    assert.equal(wake.permissionMode, 'bypassPermissions');
    assert.equal(wake.resetsAt, resetsAt * 1000, 'reset comes from account/rateLimits/updated');
    assert.match(wake.limitText, /usage limit/);
    assert.equal(wake.limitType, '5h window');

    // The turn still terminates for the client (exit 1: nothing was produced).
    assert.ok(writer.messages.some((m) => m.kind === 'complete' && m.exitCode === 1));

    const requests = (await readFile(capturePath, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(requests.filter((r) => r.method === 'turn/start').length, 1, 'no continuation turn is attempted under a limit');
    assert.equal(requests.some((r) => r.method === 'account/rateLimits/read'), false, 'the live snapshot was enough');
  });
});

test('without a prior snapshot the runner asks account/rateLimits/read for the reset', async () => {
  const resetsAt = Math.floor(Date.now() / 1000) + 7200;
  await withFakeCodex({ resetsAt, announceBeforeFail: false }, async ({ tempRoot, capturePath }) => {
    await queryCodex('Do the thing', {
      cwd: tempRoot,
      sessionId: 'codex-limited-1',
      model: 'gpt-5.4',
      permissionMode: 'acceptEdits',
    }, makeWriter());

    assert.equal(isRateLimitWakePending('codex-limited-1'), true);
    const wake = getRateLimitWake('codex-limited-1');
    assert.equal(wake.resetsAt, resetsAt * 1000, 'reset comes from account/rateLimits/read');
    const requests = (await readFile(capturePath, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(requests.filter((r) => r.method === 'turn/start').length, 1);
    assert.equal(requests.some((r) => r.method === 'account/rateLimits/read'), true, 'the snapshot was fetched on demand');
  });
});
