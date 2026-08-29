import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { registerAgentEnvContributor } from '../../../../shared/agent-env.js';
import {
  opencodeRuntime,
  injectOpenCodeMessage,
  isOpenCodeSessionActive,
  resolveOpenCodePermissionOptions,
  spawnOpenCode,
} from './opencode-runtime.provider.js';
import { OpenCodeSessionsProvider } from './opencode-sessions.provider.js';

// Stands in for a host plugin (e.g. a presence reporter's opt-out): the runtime's
// job is to tag the spawn correctly and merge what contributors return.
const unregisterContributor = registerAgentEnvContributor((context) =>
  context.ephemeral || context.private ? { VS_TEST_OPT_OUT: '1' } : null,
);
test.after(() => unregisterContributor());

const sessionsProvider = new OpenCodeSessionsProvider();
const runtimeContext = {
  resolveProviderSessionId: (sessionId) => sessionId || null,
  resolveResumeModel: async (_sessionId, requestedModel) => requestedModel || undefined,
  getProviderModels: async () => ({ OPTIONS: [], DEFAULT: '' }),
  normalizeMessage: (raw, sessionId) => sessionsProvider.normalizeMessage(raw, sessionId),
  isProviderInstalled: async () => true,
};

const findEnvKey = (name) =>
  Object.keys(process.env).find((key) => key.toLowerCase() === name.toLowerCase()) || name;

async function waitFor(predicate, message) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

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
    optOut: process.env.VS_TEST_OPT_OUT ?? null,
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

async function createFakeOpenCodeServerExecutable(binDir) {
  const scriptPath = path.join(binDir, 'opencode-server.js');
  await writeFile(scriptPath, `
const fs = require('node:fs');
const http = require('node:http');

if (process.argv[2] !== 'serve') process.exit(2);
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
const capturePath = process.env.OPENCODE_SERVER_CAPTURE;
const streams = new Set();
const sendJson = (response, status, body) => {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
};
const broadcast = (event) => {
  const frame = 'data: ' + JSON.stringify(event) + '\\n\\n';
  for (const stream of streams) stream.write(frame);
};
const readBody = (request) => new Promise((resolve) => {
  let body = '';
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => resolve(body ? JSON.parse(body) : {}));
});

const server = http.createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/api/model') {
    sendJson(response, 200, { data: [{ id: 'local', providerID: 'dudin' }] });
    return;
  }
  if (request.method === 'GET' && request.url === '/api/event') {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
    response.write(': connected\\n\\n');
    streams.add(response);
    request.on('close', () => streams.delete(response));
    return;
  }
  if (request.method === 'POST' && request.url === '/api/session') {
    await readBody(request);
    sendJson(response, 200, { data: { id: 'open-server-1' } });
    return;
  }
  if (request.method === 'POST' && /\\/api\\/session\\/open-server-1\\/(model|agent)$/.test(request.url)) {
    await readBody(request);
    sendJson(response, 200, { data: true });
    return;
  }
  if (request.method === 'POST' && request.url === '/api/session/open-server-1/prompt') {
    const body = await readBody(request);
    fs.appendFileSync(capturePath, JSON.stringify(body) + '\\n');
    const id = body.id || 'msg_initial';
    sendJson(response, 200, { data: {
      admittedSeq: body.delivery === 'steer' ? 2 : 1,
      id,
      sessionID: 'open-server-1',
      prompt: body.prompt,
      delivery: body.delivery || 'steer',
      timeCreated: Date.now(),
    } });
    if (body.delivery === 'steer') {
      setTimeout(() => {
        broadcast({ type: 'session.next.prompted', data: {
          sessionID: 'open-server-1', messageID: id, prompt: body.prompt, delivery: 'steer', timestamp: Date.now(),
        } });
        broadcast({ type: 'session.next.text.delta', data: {
          sessionID: 'open-server-1', assistantMessageID: 'msg_assistant', textID: 'text-1',
          delta: 'steered answer', timestamp: Date.now(),
        } });
        broadcast({ type: 'session.next.step.ended', data: {
          sessionID: 'open-server-1', assistantMessageID: 'msg_assistant', finish: 'stop', timestamp: Date.now(),
        } });
        server.close(() => process.exit(0));
      }, 25);
    } else {
      broadcast({ type: 'session.next.step.started', data: {
        sessionID: 'open-server-1', assistantMessageID: 'msg_assistant', timestamp: Date.now(),
      } });
    }
    return;
  }
  if (request.method === 'GET' && request.url === '/api/session/open-server-1/context') {
    sendJson(response, 200, { data: {} });
    return;
  }
  if (request.method === 'POST' && request.url === '/api/session/open-server-1/interrupt') {
    sendJson(response, 200, { data: true });
    return;
  }
  sendJson(response, 404, { error: 'not found' });
});
server.listen(port, '127.0.0.1', () => {
  console.log('opencode server listening on http://127.0.0.1:' + port);
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`, 'utf8');

  if (process.platform === 'win32') {
    await writeFile(path.join(binDir, 'opencode.cmd'), '@echo off\r\nnode "%~dp0opencode-server.js" %*\r\n', 'utf8');
    return;
  }

  const commandPath = path.join(binDir, 'opencode');
  await writeFile(commandPath, '#!/bin/sh\nexec node "$(dirname "$0")/opencode-server.js" "$@"\n', 'utf8');
  await chmod(commandPath, 0o755);
}

test('OpenCode injection falls back when no server turn is active', async () => {
  assert.equal(await injectOpenCodeMessage('missing-open-session', 'Queue me'), null);
});

test('interactive OpenCode turns admit queued messages as live steers', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-server-steer-'));
  const capturePath = path.join(tempRoot, 'requests.jsonl');
  const pathKey = findEnvKey('PATH');
  const pathExtKey = findEnvKey('PATHEXT');
  const previousPath = process.env[pathKey];
  const previousPathExt = process.env[pathExtKey];
  const previousCapture = process.env.OPENCODE_SERVER_CAPTURE;
  const originalHomedir = os.homedir;
  const messages = [];
  const writer = {
    userId: null,
    sessionId: null,
    send(message) { messages.push(message); },
    setSessionId(sessionId) { this.sessionId = sessionId; },
  };

  try {
    await createFakeOpenCodeServerExecutable(tempRoot);
    process.env[pathKey] = `${tempRoot}${path.delimiter}${previousPath || ''}`;
    process.env.OPENCODE_SERVER_CAPTURE = capturePath;
    os.homedir = () => tempRoot;
    if (process.platform === 'win32') {
      process.env[pathExtKey] = previousPathExt?.toUpperCase().includes('.CMD')
        ? previousPathExt
        : `.COM;.EXE;.BAT;.CMD${previousPathExt ? `;${previousPathExt}` : ''}`;
    }

    const running = spawnOpenCode('Start the task', {
      cwd: tempRoot,
      model: 'dudin/local',
      enableMidTurnInjection: true,
      ephemeral: true,
    }, writer);
    await waitFor(
      () => isOpenCodeSessionActive('open-server-1'),
      'the fake OpenCode server turn never became active',
    );

    let delivered = 0;
    const injectedId = await injectOpenCodeMessage('open-server-1', 'Use the new direction.', {
      clientUserMessageId: 'queued-1',
      onDelivered: () => { delivered += 1; },
    });
    await running;

    assert.match(injectedId, /^msg_/);
    assert.equal(delivered, 1);
    const userMessage = messages.find((message) => message.id === 'queued-1');
    const assistantMessage = messages.find((message) => message.content === 'steered answer');
    assert.equal(userMessage?.role, 'user');
    assert.equal(userMessage?.content, 'Use the new direction.');
    assert.ok(messages.indexOf(userMessage) < messages.indexOf(assistantMessage));
    assert.equal(messages.filter((message) => message.kind === 'complete').length, 1);

    const requests = (await readFile(capturePath, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(requests[0].prompt.text, 'Start the task');
    assert.equal(requests[1].delivery, 'steer');
    assert.equal(requests[1].prompt.text, 'Use the new direction.');
  } finally {
    os.homedir = originalHomedir;
    if (previousPath === undefined) delete process.env[pathKey];
    else process.env[pathKey] = previousPath;
    if (previousPathExt === undefined) delete process.env[pathExtKey];
    else process.env[pathExtKey] = previousPathExt;
    if (previousCapture === undefined) delete process.env.OPENCODE_SERVER_CAPTURE;
    else process.env.OPENCODE_SERVER_CAPTURE = previousCapture;
    await rm(tempRoot, { recursive: true, force: true });
  }
});

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

    await opencodeRuntime.run('Hi', { cwd: tempRoot }, writer, runtimeContext);

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

    const attachmentOnlyCapturePath = path.join(tempRoot, 'opencode-attachment-only.json');
    process.env.OPENCODE_ARGS_CAPTURE = attachmentOnlyCapturePath;
    await opencodeRuntime.run(
      '',
      {
        cwd: tempRoot,
        files: [{
          path: path.join(tempRoot, 'brief.pdf'),
          name: 'brief.pdf',
          mimeType: 'application/pdf',
        }],
      },
      writer,
      runtimeContext,
    );
    const attachmentOnlyCapture = JSON.parse(await readFile(attachmentOnlyCapturePath, 'utf8'));
    const attachmentPrompt = attachmentOnlyCapture.args[attachmentOnlyCapture.args.length - 1];
    assert.match(attachmentPrompt, /<files_input>/);
    assert.match(attachmentPrompt, /brief\.pdf/);
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

      await opencodeRuntime.run(
        'Hi',
        { cwd: tempRoot, permissionMode: scenario.permissionMode },
        writer,
        runtimeContext,
      );

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

test('ephemeral OpenCode helpers are tagged for host plugin contributors', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-cli-ephemeral-'));
  const argsCapturePath = path.join(tempRoot, 'opencode-args-ephemeral.json');
  const pathKey = findEnvKey('PATH');
  const pathExtKey = findEnvKey('PATHEXT');
  const previousPath = process.env[pathKey];
  const previousPathExt = process.env[pathExtKey];
  const previousArgsCapture = process.env.OPENCODE_ARGS_CAPTURE;
  const writer = { userId: null, send() {}, setSessionId() {} };

  try {
    await createFakeOpenCodeExecutable(tempRoot);
    process.env[pathKey] = `${tempRoot}${path.delimiter}${previousPath || ''}`;
    process.env.OPENCODE_ARGS_CAPTURE = argsCapturePath;
    if (process.platform === 'win32') {
      process.env[pathExtKey] = previousPathExt?.toUpperCase().includes('.CMD')
        ? previousPathExt
        : `.COM;.EXE;.BAT;.CMD${previousPathExt ? `;${previousPathExt}` : ''}`;
    }

    await spawnOpenCode('summarise this', { cwd: tempRoot, ephemeral: true }, writer);

    const capture = JSON.parse(await readFile(argsCapturePath, 'utf8'));
    assert.equal(capture.optOut, '1');
  } finally {
    if (previousPath === undefined) delete process.env[pathKey];
    else process.env[pathKey] = previousPath;
    if (previousPathExt === undefined) delete process.env[pathExtKey];
    else process.env[pathExtKey] = previousPathExt;
    if (previousArgsCapture === undefined) delete process.env.OPENCODE_ARGS_CAPTURE;
    else process.env.OPENCODE_ARGS_CAPTURE = previousArgsCapture;
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
