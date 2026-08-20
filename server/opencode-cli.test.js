import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveOpenCodePermissionOptions, spawnOpenCode } from './opencode-cli.js';

const findEnvKey = (name) =>
  Object.keys(process.env).find((key) => key.toLowerCase() === name.toLowerCase()) || name;

async function createFakeOpenCodeExecutable(binDir) {
  const scriptPath = path.join(binDir, 'opencode.js');
  await writeFile(scriptPath, `
const capturePath = process.env.OPENCODE_ARGS_CAPTURE;
// A finished turn also asks the CLI for the model catalog, to size the context
// gauge. That is a second invocation of this same fake, and it must not
// overwrite the capture of the run these tests are actually inspecting.
if (capturePath && process.argv[2] !== 'models') {
  require('node:fs').writeFileSync(capturePath, JSON.stringify({
    args: process.argv.slice(2),
    permissionEnv: process.env.OPENCODE_PERMISSION ?? null,
  }));
}

const events = [
  { type: 'text', sessionID: 'open-live-1', text: 'assistant response' },
  { type: 'step_finish', sessionID: 'open-live-1' },
];

for (const event of events) {
  console.log(JSON.stringify(event));
}
`, 'utf8');

  if (process.platform === 'win32') {
    const commandPath = path.join(binDir, 'opencode.cmd');
    await writeFile(commandPath, '@echo off\r\nnode "%~dp0opencode.js" %*\r\n', 'utf8');
    return;
  }

  const commandPath = path.join(binDir, 'opencode');
  await writeFile(commandPath, '#!/bin/sh\nnode "$(dirname "$0")/opencode.js" "$@"\n', 'utf8');
  await chmod(commandPath, 0o755);
}

test('spawnOpenCode emits session_created before normalized live messages for new sessions', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-cli-live-'));
  const argsCapturePath = path.join(tempRoot, 'opencode-args.json');
  const pathKey = findEnvKey('PATH');
  const pathExtKey = findEnvKey('PATHEXT');
  const previousPath = process.env[pathKey];
  const previousPathExt = process.env[pathExtKey];
  const previousArgsCapture = process.env.OPENCODE_ARGS_CAPTURE;
  const messages = [];
  const writer = {
    userId: null,
    sessionId: null,
    send(message) {
      messages.push(message);
    },
    setSessionId(sessionId) {
      this.sessionId = sessionId;
    },
  };

  try {
    await createFakeOpenCodeExecutable(tempRoot);
    process.env[pathKey] = `${tempRoot}${path.delimiter}${previousPath || ''}`;
    process.env.OPENCODE_ARGS_CAPTURE = argsCapturePath;
    if (process.platform === 'win32') {
      process.env[pathExtKey] = previousPathExt?.toUpperCase().includes('.CMD')
        ? previousPathExt
        : `.COM;.EXE;.BAT;.CMD${previousPathExt ? `;${previousPathExt}` : ''}`;
    }

    await spawnOpenCode('Hi', { cwd: tempRoot }, writer);

    const sessionCreatedIndex = messages.findIndex((message) => message.kind === 'session_created');
    const assistantDeltaIndex = messages.findIndex((message) =>
      message.kind === 'stream_delta' && message.content === 'assistant response',
    );
    const streamEnd = messages.find((message) => message.kind === 'stream_end');
    const complete = messages.find((message) => message.kind === 'complete');

    assert.notEqual(sessionCreatedIndex, -1);
    assert.notEqual(assistantDeltaIndex, -1);
    assert.ok(sessionCreatedIndex < assistantDeltaIndex);
    assert.equal(messages[sessionCreatedIndex].newSessionId, 'open-live-1');
    assert.equal(writer.sessionId, 'open-live-1');
    assert.equal(streamEnd?.sessionId, 'open-live-1');
    assert.equal(complete?.sessionId, 'open-live-1');
    assert.equal(messages.some((message) => message.kind === 'error'), false);

    const capture = JSON.parse(await readFile(argsCapturePath, 'utf8'));
    const launchedArgs = capture.args;
    assert.ok(Array.isArray(launchedArgs));
    assert.deepEqual(launchedArgs.slice(0, 4), ['run', '--format', 'json', '--dir']);
    assert.equal(launchedArgs[4], tempRoot);
    // No permission mode requested → no permission flags and no env override.
    assert.equal(launchedArgs.includes('--auto'), false);
    assert.equal(launchedArgs.includes('--agent'), false);
    assert.equal(capture.permissionEnv, null);
  } finally {
    if (previousPath === undefined) {
      delete process.env[pathKey];
    } else {
      process.env[pathKey] = previousPath;
    }

    if (previousPathExt === undefined) {
      delete process.env[pathExtKey];
    } else {
      process.env[pathExtKey] = previousPathExt;
    }

    if (previousArgsCapture === undefined) {
      delete process.env.OPENCODE_ARGS_CAPTURE;
    } else {
      process.env.OPENCODE_ARGS_CAPTURE = previousArgsCapture;
    }

    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('resolveOpenCodePermissionOptions maps UI permission modes onto OpenCode controls', () => {
  assert.deepEqual(resolveOpenCodePermissionOptions('plan'), {
    args: ['--agent', 'plan'],
    env: {},
  });
  assert.deepEqual(resolveOpenCodePermissionOptions('bypassPermissions'), {
    args: ['--auto'],
    env: {},
  });
  assert.deepEqual(resolveOpenCodePermissionOptions('acceptEdits'), {
    args: [],
    env: { OPENCODE_PERMISSION: '{"edit":"allow"}' },
  });
  // default and anything unknown leave the user's own opencode config in charge.
  assert.deepEqual(resolveOpenCodePermissionOptions('default'), { args: [], env: {} });
  assert.deepEqual(resolveOpenCodePermissionOptions(undefined), { args: [], env: {} });
});

test('spawnOpenCode passes permission mode flags and env to the CLI', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-cli-perms-'));
  const pathKey = findEnvKey('PATH');
  const pathExtKey = findEnvKey('PATHEXT');
  const previousPath = process.env[pathKey];
  const previousPathExt = process.env[pathExtKey];
  const previousArgsCapture = process.env.OPENCODE_ARGS_CAPTURE;
  const writer = {
    userId: null,
    sessionId: null,
    send() {},
    setSessionId(sessionId) {
      this.sessionId = sessionId;
    },
  };

  try {
    await createFakeOpenCodeExecutable(tempRoot);
    process.env[pathKey] = `${tempRoot}${path.delimiter}${previousPath || ''}`;
    if (process.platform === 'win32') {
      process.env[pathExtKey] = previousPathExt?.toUpperCase().includes('.CMD')
        ? previousPathExt
        : `.COM;.EXE;.BAT;.CMD${previousPathExt ? `;${previousPathExt}` : ''}`;
    }

    const scenarios = [
      {
        permissionMode: 'plan',
        expectArgs: ['--agent', 'plan'],
        expectPermissionEnv: null,
      },
      {
        permissionMode: 'bypassPermissions',
        expectArgs: ['--auto'],
        expectPermissionEnv: null,
      },
      {
        permissionMode: 'acceptEdits',
        expectArgs: [],
        expectPermissionEnv: '{"edit":"allow"}',
      },
    ];

    for (const scenario of scenarios) {
      const argsCapturePath = path.join(tempRoot, `opencode-args-${scenario.permissionMode}.json`);
      process.env.OPENCODE_ARGS_CAPTURE = argsCapturePath;

      await spawnOpenCode('Hi', { cwd: tempRoot, permissionMode: scenario.permissionMode }, writer);

      const capture = JSON.parse(await readFile(argsCapturePath, 'utf8'));
      for (const expectedArg of scenario.expectArgs) {
        assert.ok(
          capture.args.includes(expectedArg),
          `${scenario.permissionMode}: expected "${expectedArg}" in ${JSON.stringify(capture.args)}`,
        );
      }
      // The prompt stays the last positional argument, after any permission flags.
      assert.equal(capture.args[capture.args.length - 1], 'Hi');
      assert.equal(capture.permissionEnv, scenario.expectPermissionEnv);
    }
  } finally {
    if (previousPath === undefined) {
      delete process.env[pathKey];
    } else {
      process.env[pathKey] = previousPath;
    }

    if (previousPathExt === undefined) {
      delete process.env[pathExtKey];
    } else {
      process.env[pathExtKey] = previousPathExt;
    }

    if (previousArgsCapture === undefined) {
      delete process.env.OPENCODE_ARGS_CAPTURE;
    } else {
      process.env.OPENCODE_ARGS_CAPTURE = previousArgsCapture;
    }

    await rm(tempRoot, { recursive: true, force: true });
  }
});

/**
 * Fake `opencode` whose `run` fails with a locked database for the first
 * `lockedAttempts` invocations, counting them in `attemptsPath`.
 *
 * `splitWrites` reports the failure the way the real binary does under load:
 * the `Error:` header and the detail below it are separate writes, so the
 * parent reads them as two chunks and neither one is the whole message.
 *
 * `models --verbose` always answers so the catalog probe the run makes on its
 * way in does not become the thing under test.
 */
async function createLockingOpenCodeExecutable(binDir, attemptsPath, lockedAttempts, splitWrites) {
  const scriptPath = path.join(binDir, 'opencode.js');
  await writeFile(scriptPath, `
const fs = require('node:fs');
if (process.argv[2] === 'models') {
  console.log('dudin/only-real-model');
  process.exit(0);
}

const attempt = Number(fs.readFileSync(${JSON.stringify(attemptsPath)}, 'utf8')) + 1;
fs.writeFileSync(${JSON.stringify(attemptsPath)}, String(attempt));

if (attempt <= ${lockedAttempts}) {
  // Byte-for-byte what opencode writes when it loses the race for opencode.db,
  // colour codes included: it never checks isTTY.
  const header = '\\u001b[91m\\u001b[1mError: \\u001b[0mUnexpected error\\n\\n';
  const detail = 'database is locked\\n';
  if (${splitWrites ? 'true' : 'false'}) {
    process.stderr.write(header, () => {
      setTimeout(() => process.stderr.write(detail, () => process.exit(1)), 25);
    });
  } else {
    process.stderr.write(header + detail);
    process.exit(1);
  }
  return;
}

console.log(JSON.stringify({ type: 'text', sessionID: 'open-lock-1', part: { type: 'text', text: 'ran on the retry' } }));
`, 'utf8');

  if (process.platform === 'win32') {
    await writeFile(path.join(binDir, 'opencode.cmd'), '@echo off\r\nnode "%~dp0opencode.js" %*\r\n', 'utf8');
    return;
  }

  const commandPath = path.join(binDir, 'opencode');
  await writeFile(commandPath, '#!/bin/sh\nnode "$(dirname "$0")/opencode.js" "$@"\n', 'utf8');
  await chmod(commandPath, 0o755);
}

async function withLockingOpenCode(lockedAttempts, assertions, { splitWrites = false } = {}) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-cli-lock-'));
  const attemptsPath = path.join(tempRoot, 'attempts');
  const pathKey = findEnvKey('PATH');
  const pathExtKey = findEnvKey('PATHEXT');
  const previousPath = process.env[pathKey];
  const previousPathExt = process.env[pathExtKey];
  const messages = [];
  const writer = {
    userId: null,
    sessionId: null,
    send(message) {
      messages.push(message);
    },
    setSessionId(sessionId) {
      this.sessionId = sessionId;
    },
  };

  try {
    await writeFile(attemptsPath, '0', 'utf8');
    await createLockingOpenCodeExecutable(tempRoot, attemptsPath, lockedAttempts, splitWrites);
    process.env[pathKey] = `${tempRoot}${path.delimiter}${previousPath || ''}`;
    if (process.platform === 'win32') {
      process.env[pathExtKey] = previousPathExt?.toUpperCase().includes('.CMD')
        ? previousPathExt
        : `.COM;.EXE;.BAT;.CMD${previousPathExt ? `;${previousPathExt}` : ''}`;
    }

    let runError = null;
    try {
      await spawnOpenCode('Hi', { cwd: tempRoot }, writer);
    } catch (error) {
      runError = error;
    }

    await assertions({
      messages,
      runError,
      attempts: Number(await readFile(attemptsPath, 'utf8')),
    });
  } finally {
    if (previousPath === undefined) {
      delete process.env[pathKey];
    } else {
      process.env[pathKey] = previousPath;
    }

    if (previousPathExt === undefined) {
      delete process.env[pathExtKey];
    } else {
      process.env[pathExtKey] = previousPathExt;
    }

    await rm(tempRoot, { recursive: true, force: true });
  }
}

// Every opencode on the machine writes to one WAL database, so a run can die at
// init because another one — or this server's own catalog probe — held the lock
// past opencode's 5 s busy_timeout. Nothing ran, so re-running repeats nothing.
test('OpenCode run that loses the race for opencode.db is retried, not surfaced', async () => {
  await withLockingOpenCode(1, ({ messages, runError, attempts }) => {
    assert.equal(runError, null);
    assert.equal(attempts, 2);
    assert.equal(messages.some((message) => message.kind === 'error'), false);
    assert.equal(messages.filter((message) => message.kind === 'complete').length, 1);
  });
});

test('OpenCode run that keeps losing it reports the lock once, in plain text', async () => {
  await withLockingOpenCode(5, ({ messages, runError, attempts }) => {
    assert.notEqual(runError, null);
    // One retry, then it tells the user instead of retrying forever.
    assert.equal(attempts, 2);

    const errors = messages.filter((message) => message.kind === 'error');
    assert.equal(errors.length, 1);
    assert.match(errors[0].content, /database is locked/);
    assert.match(errors[0].content, /Nothing was lost and nothing is corrupt/);
    // The colour codes never reach the browser.
    assert.doesNotMatch(errors[0].content, /\u001B/);
  });
});

// The failure arrives in pieces: opencode writes the `Error:` header and the
// detail under it separately, and a loaded server reads them as two chunks.
// Judged a chunk at a time, the header is not the lock error it belongs to, so
// it went out as a bare "Error: Unexpected error" bubble a second before the
// retry succeeded — an error on screen for a turn that worked.
test('OpenCode lock error split across stderr chunks is still recognised, not half-shown', async () => {
  await withLockingOpenCode(1, ({ messages, runError, attempts }) => {
    assert.equal(runError, null);
    assert.equal(attempts, 2);
    assert.deepEqual(messages.filter((message) => message.kind === 'error'), []);
    assert.equal(messages.filter((message) => message.kind === 'complete').length, 1);
  }, { splitWrites: true });
});

test('OpenCode lock error split across stderr chunks is reported whole once retries run out', async () => {
  await withLockingOpenCode(5, ({ messages, runError }) => {
    assert.notEqual(runError, null);

    const errors = messages.filter((message) => message.kind === 'error');
    assert.equal(errors.length, 1);
    // Both halves, in one bubble — the header is meaningless without the detail.
    assert.match(errors[0].content, /Unexpected error/);
    assert.match(errors[0].content, /database is locked/);
    assert.match(errors[0].content, /Nothing was lost and nothing is corrupt/);
  }, { splitWrites: true });
});
