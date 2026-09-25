import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Regression for the 2026-09-12 incident: a private Codex app-server hosting
// title/recap helpers accumulated 613 MCP children (npm Playwright MCP,
// mc-reporter), because every helper thread loaded every configured MCP server
// and was never unloaded. A helper must start without MCP, be released on
// every exit path, and only a bounded number may run at once.

const directory = await mkdtemp(path.join(tmpdir(), 'codex-helper-release-'));
process.env.DATABASE_PATH = path.join(directory, 'auth.db');
process.env.MC_DISABLE = '1';
const { initializeDatabase, closeConnection } = await import('@/modules/database/index.js');
const { closeSessionsWatcher } = await import('../index.js');
// eslint-disable-next-line boundaries/no-unknown -- Integration coverage for the legacy runtime outside modules.
const { queryCodex, abortCodexSession, isCodexSessionActive } = await import('../../../openai-codex.js');
// eslint-disable-next-line boundaries/no-unknown -- Shut down the legacy runtime's real test transport.
const { stopCodexAppServer } = await import('../../../services/codex-app-server.service.js');

type Captured = { method: string; id?: number; params?: Record<string, any> };

const capture = path.join(directory, 'requests.jsonl');
const executable = path.join(directory, 'codex');

// Prompts steer the fake: "ok" completes, "fail" ends in a failed turn,
// "rpc-error" rejects turn/start, "hold" runs until interrupted, "slow"
// completes after a delay so overlapping helpers can be observed.
await writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const rl = require('node:readline').createInterface({ input: process.stdin });
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
let serial = 0;
const turns = new Map();
rl.on('line', line => {
  const req = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(capture)}, line + '\\n');
  const p = req.params || {};
  switch (req.method) {
    case 'initialize': send({ id: req.id, result: {} }); break;
    case 'config/read':
      send({ id: req.id, result: { config: { mcp_servers: {
        playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
        mc: { command: 'mc-reporter', args: ['mcp'] },
      } } } });
      break;
    case 'thread/start': {
      const threadId = 'helper-' + (++serial);
      fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify({ method: 'fake/thread-created', params: { threadId } }) + '\\n');
      send({ id: req.id, result: { thread: { id: threadId } } });
      break;
    }
    case 'thread/resume': send({ id: req.id, result: { thread: { id: p.threadId } } }); break;
    case 'thread/unsubscribe': send({ id: req.id, result: { status: 'unsubscribed' } }); break;
    case 'turn/start': {
      const text = p.input?.[0]?.text || '';
      if (text === 'rpc-error') { send({ id: req.id, error: { code: -32000, message: 'synthetic turn/start failure' } }); break; }
      const turnId = 'turn-' + p.threadId;
      turns.set(p.threadId, turnId);
      send({ id: req.id, result: { turn: { id: turnId, status: 'inProgress' } } });
      send({ method: 'turn/started', params: { threadId: p.threadId, turn: { id: turnId } } });
      const finish = status => send({ method: 'turn/completed', params: { threadId: p.threadId,
        turn: { id: turnId, status, error: status === 'failed' ? { message: 'synthetic failure' } : undefined } } });
      if (text === 'ok') finish('completed');
      if (text === 'fail') finish('failed');
      if (text === 'slow') setTimeout(() => finish('completed'), 80);
      break;
    }
    case 'turn/interrupt':
      send({ id: req.id, result: {} });
      send({ method: 'turn/completed', params: { threadId: p.threadId, turn: { id: p.turnId, status: 'interrupted' } } });
      break;
  }
});
`);
await chmod(executable, 0o755);
process.env.VIBESPACE_CODEX_PATH = executable;
await initializeDatabase();

const runtimeContext = {
  resolveProviderSessionId: (id: string) => id,
  resolveResumeModel: async () => 'gpt-5.6-luna',
  getProviderModels: async () => ({ DEFAULT: 'gpt-5.6-luna', OPTIONS: [{ value: 'gpt-5.6-luna', label: 'Luna' }] }),
  normalizeMessage: () => [],
  isProviderInstalled: async () => true,
};

async function readRequests(): Promise<Captured[]> {
  const text = await readFile(capture, 'utf8').catch(() => '');
  return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Captured);
}

async function resetCapture() {
  await writeFile(capture, '');
}

function helper(prompt: string, extra: Record<string, unknown> = {}, writer: Record<string, unknown> = {}) {
  return queryCodex(prompt, {
    cwd: directory,
    model: 'gpt-5.6-luna',
    permissionMode: 'plan',
    ephemeral: true,
    private: true,
    backgroundHelper: true,
    ...extra,
  }, { send() {}, setSessionId() {}, ...writer }, runtimeContext);
}

/** The threads started, and the ones released, in request order. */
function lifecycle(requests: Captured[]) {
  return {
    started: requests.filter(r => r.method === 'fake/thread-created').map(r => r.params!.threadId as string),
    released: requests.filter(r => r.method === 'thread/unsubscribe').map(r => r.params!.threadId as string),
  };
}

test.after(async () => {
  stopCodexAppServer();
  closeSessionsWatcher();
  closeConnection();
  await rm(directory, { recursive: true, force: true });
});

test('a background helper starts with every configured MCP server disabled', async () => {
  await resetCapture();
  await helper('ok');
  const start = (await readRequests()).find(r => r.method === 'thread/start');
  assert.ok(start, 'the helper started a thread');
  assert.equal(start.params!.ephemeral, true);
  assert.deepEqual(start.params!.config.mcp_servers, {
    playwright: { enabled: false },
    mc: { enabled: false },
  });
});

test('a helper thread is released after success, failed turn, turn/start error and abort', async () => {
  await resetCapture();
  await helper('ok');
  await helper('fail');
  await helper('rpc-error');

  let heldThread: string | null = null;
  const held = helper('hold', {}, { setSessionId(id: string) { heldThread = id; } });
  const deadline = Date.now() + 5_000;
  while ((!heldThread || !isCodexSessionActive(heldThread)) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(heldThread, 'the held helper started');
  // The turn id arrives with turn/start's response; abort needs it.
  while (!(await abortCodexSession(heldThread)) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await held;

  const { started, released } = lifecycle(await readRequests());
  assert.equal(started.length, 4);
  assert.deepEqual([...released].sort(), [...started].sort(), 'every helper thread was unsubscribed');
  assert.equal(isCodexSessionActive(heldThread), false);
});

test('only a bounded number of background helpers hold a loaded thread at once', async () => {
  await resetCapture();
  await Promise.all(Array.from({ length: 6 }, () => helper('slow')));
  const requests = await readRequests();
  const { started, released } = lifecycle(requests);
  assert.equal(started.length, 6);
  assert.equal(released.length, 6);

  // Replay the request stream: a thread counts from thread/start until its unsubscribe.
  let loaded = 0;
  let peak = 0;
  for (const r of requests) {
    if (r.method === 'thread/start') peak = Math.max(peak, ++loaded);
    if (r.method === 'thread/unsubscribe') loaded -= 1;
  }
  assert.ok(peak <= 2, `at most two helper threads loaded at once, saw ${peak}`);
});

test('one-shot ephemeral calls keep MCP; only threads the call started are released', async () => {
  await resetCapture();
  // The REST automation endpoint: ephemeral, but may want MCP tools.
  await queryCodex('ok', { cwd: directory, permissionMode: 'bypassPermissions', ephemeral: true },
    { send() {}, setSessionId() {} }, runtimeContext);
  // Ephemeral resume of an existing thread: a live session may share it.
  await queryCodex('ok', { cwd: directory, permissionMode: 'bypassPermissions', ephemeral: true, sessionId: 'live-thread' },
    { send() {}, setSessionId() {} }, runtimeContext);

  const requests = await readRequests();
  const start = requests.find(r => r.method === 'thread/start');
  assert.equal(start?.params?.config?.mcp_servers, undefined, 'MCP left alone outside title/recap helpers');
  assert.equal(requests.some(r => r.method === 'config/read'), false);
  const released = requests.filter(r => r.method === 'thread/unsubscribe').map(r => r.params!.threadId);
  assert.equal(released.length, 1, 'the started thread was released');
  assert.ok(!released.includes('live-thread'), 'a resumed thread is never unsubscribed');
});
