import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { spawnOpenCode } from '@/modules/providers/list/opencode/opencode-runtime.provider.js';

const findEnvKey = (name: string): string => (
  Object.keys(process.env).find((key) => key.toLowerCase() === name.toLowerCase()) || name
);

async function createFakeOpenCode(binDir: string): Promise<void> {
  const scriptPath = path.join(binDir, 'opencode.js');
  await writeFile(scriptPath, `
const fs = require('node:fs');
const http = require('node:http');

if (process.argv[2] !== 'serve') {
  if (process.argv[2] === 'models') {
    console.log('homelab/local');
    console.log(JSON.stringify({ id: 'local', providerID: 'homelab', limit: { context: 65536, output: 8192 } }));
    process.exit(0);
  }
  fs.writeFileSync(process.env.OPENCODE_CLI_CAPTURE, JSON.stringify(process.argv.slice(2)));
  console.log(JSON.stringify({ type: 'step_finish', sessionID: 'open-existing' }));
  process.exit(0);
}

const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
const readBody = (request) => new Promise((resolve) => {
  let body = '';
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => resolve(body ? JSON.parse(body) : null));
});
const send = (response, status, body) => {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
};
const server = http.createServer(async (request, response) => {
  if (request.method === 'GET' && request.url.split('?')[0] === '/api/model') {
    send(response, 200, { data: [{ id: 'local', providerID: 'homelab' }] });
    return;
  }
  if (request.method === 'GET' && request.url === '/path') {
    send(response, 200, {});
    return;
  }
  if (request.method === 'POST' && request.url.startsWith('/session/open-existing/summarize?')) {
    const body = await readBody(request);
    fs.writeFileSync(process.env.OPENCODE_COMPACT_CAPTURE, JSON.stringify({ url: request.url, body }));
    send(response, 200, true);
    setImmediate(() => server.close(() => process.exit(0)));
    return;
  }
  send(response, 404, { error: 'not found' });
});
server.listen(port, '127.0.0.1', () => {
  console.log('opencode server listening on http://127.0.0.1:' + port);
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`, 'utf8');

  const commandPath = path.join(binDir, 'opencode');
  await writeFile(commandPath, '#!/bin/sh\nexec node "$(dirname "$0")/opencode.js" "$@"\n', 'utf8');
  await chmod(commandPath, 0o755);
}

test('OpenCode /compact uses native summarization and keeps later turns off the stale server context', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-compact-command-'));
  const compactCapturePath = path.join(tempRoot, 'compact.json');
  const cliCapturePath = path.join(tempRoot, 'cli.json');
  const pathKey = findEnvKey('PATH');
  const previousPath = process.env[pathKey];
  const previousCompactCapture = process.env.OPENCODE_COMPACT_CAPTURE;
  const previousCliCapture = process.env.OPENCODE_CLI_CAPTURE;
  const previousConfigHome = process.env.XDG_CONFIG_HOME;
  const previousTrackWindow = process.env.VIBESPACE_OPENCODE_TRACK_MODEL_WINDOW;
  const messages: Array<Record<string, unknown>> = [];
  const writer = {
    userId: null,
    send(message: Record<string, unknown>) {
      messages.push(message);
    },
    setSessionId() {},
  };
  const runtimeContext = {
    resolveProviderSessionId: (sessionId: string) => sessionId,
    resolveResumeModel: async (_sessionId: string, requestedModel: string) => requestedModel,
    getProviderModels: async () => ({ OPTIONS: [], DEFAULT: '' }),
    normalizeMessage: () => [],
    isProviderInstalled: async () => true,
  };

  try {
    await createFakeOpenCode(tempRoot);
    process.env[pathKey] = `${tempRoot}${path.delimiter}${previousPath || ''}`;
    process.env.OPENCODE_COMPACT_CAPTURE = compactCapturePath;
    process.env.OPENCODE_CLI_CAPTURE = cliCapturePath;
    const configHome = path.join(tempRoot, 'config');
    process.env.XDG_CONFIG_HOME = configHome;
    process.env.VIBESPACE_OPENCODE_TRACK_MODEL_WINDOW = '0';
    await mkdir(path.join(configHome, 'opencode'), { recursive: true });
    await writeFile(path.join(configHome, 'opencode', 'opencode.json'), JSON.stringify({
      model: 'homelab/local',
      provider: {
        homelab: { models: { local: { limit: { context: 65_536, output: 8_192 } } } },
      },
    }), 'utf8');

    await spawnOpenCode('/compact', {
      cwd: tempRoot,
      sessionId: 'open-existing',
      model: 'homelab/local',
      enableMidTurnInjection: true,
      ephemeral: true,
    }, writer, runtimeContext);

    const compactRequest = JSON.parse(await readFile(compactCapturePath, 'utf8'));
    assert.match(compactRequest.url, /^\/session\/open-existing\/summarize\?/);
    assert.equal(new URL(`http://localhost${compactRequest.url}`).searchParams.get('directory'), tempRoot);
    assert.deepEqual(compactRequest.body, {
      providerID: 'homelab',
      modelID: 'local',
      auto: false,
    });
    assert.equal(messages.some((message) => message.kind === 'compact_boundary'), true);
    assert.equal(messages.filter((message) => message.kind === 'complete').length, 1);

    messages.length = 0;
    await spawnOpenCode('Continue after compacting', {
      cwd: tempRoot,
      sessionId: 'open-existing',
      model: 'homelab/local',
      enableMidTurnInjection: true,
      ephemeral: true,
    }, writer, runtimeContext);

    const cliArgs = JSON.parse(await readFile(cliCapturePath, 'utf8')) as string[];
    assert.deepEqual(cliArgs.slice(0, 4), ['run', '--format', 'json', '--dir']);
    assert.equal(cliArgs.includes('--session'), true);
    assert.equal(cliArgs.at(-1), 'Continue after compacting');
  } finally {
    if (previousPath === undefined) delete process.env[pathKey];
    else process.env[pathKey] = previousPath;
    if (previousCompactCapture === undefined) delete process.env.OPENCODE_COMPACT_CAPTURE;
    else process.env.OPENCODE_COMPACT_CAPTURE = previousCompactCapture;
    if (previousCliCapture === undefined) delete process.env.OPENCODE_CLI_CAPTURE;
    else process.env.OPENCODE_CLI_CAPTURE = previousCliCapture;
    if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfigHome;
    if (previousTrackWindow === undefined) delete process.env.VIBESPACE_OPENCODE_TRACK_MODEL_WINDOW;
    else process.env.VIBESPACE_OPENCODE_TRACK_MODEL_WINDOW = previousTrackWindow;
    await rm(tempRoot, { recursive: true, force: true });
  }
});
