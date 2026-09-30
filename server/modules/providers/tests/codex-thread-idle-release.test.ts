import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// P6 (2026-09-29 pipe exhaustion): interactive Codex threads stayed loaded in
// the shared app-server — with every MCP child they started — for the
// app-server's whole life. An idle interactive thread must be unloaded, but
// never while a turn (or a history read) in this process is using it.

const directory = await mkdtemp(path.join(tmpdir(), 'codex-thread-idle-'));
process.env.DATABASE_PATH = path.join(directory, 'auth.db');
process.env.MC_DISABLE = '1';
process.env.VIBESPACE_CODEX_THREAD_IDLE_MS = '150';
const { initializeDatabase, closeConnection } = await import('@/modules/database/index.js');
const { closeSessionsWatcher } = await import('../index.js');
const { markCodexRevertedHistory, readCodexRevertedHistory } = await import('../services/codex-reverted-history.service.js');
// eslint-disable-next-line boundaries/no-unknown -- Integration coverage for the legacy runtime outside modules.
const { queryCodex, abortCodexSession, isCodexSessionActive, getCodexThreadResidency } = await import('../../../openai-codex.js');
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
      const threadId = 'thread-' + (++serial);
      fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify({ method: 'fake/thread-created', params: { threadId } }) + '\\n');
      send({ id: req.id, result: { thread: { id: threadId } } });
      break;
    }
    case 'thread/resume': send({ id: req.id, result: { thread: { id: p.threadId } } }); break;
    case 'thread/turns/list': setTimeout(() => send({ id: req.id, result: { data: [] } }), 400); break;
    case 'thread/unsubscribe': send({ id: req.id, result: { status: 'unsubscribed' } }); break;
    case 'turn/start': {
      const text = p.input?.[0]?.text || '';
      if (text === 'rpc-error') { send({ id: req.id, error: { code: -32000, message: 'synthetic turn/start failure' } }); break; }
      const turnId = 'turn-' + p.threadId + '-' + (++serial);
      turns.set(p.threadId, turnId);
      send({ id: req.id, result: { turn: { id: turnId, status: 'inProgress' } } });
      send({ method: 'turn/started', params: { threadId: p.threadId, turn: { id: turnId } } });
      const finish = status => send({ method: 'turn/completed', params: { threadId: p.threadId,
        turn: { id: turnId, status, error: status === 'failed' ? { message: 'synthetic failure' } : undefined } } });
      if (text === 'ok') finish('completed');
      if (text === 'fail') finish('failed');
      if (text === 'slow') setTimeout(() => finish('completed'), 80);
      if (text === 'slow400') setTimeout(() => finish('completed'), 400);
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

async function unsubscribed(threadId: string) {
  return (await readRequests()).filter(r => r.method === 'thread/unsubscribe' && r.params?.threadId === threadId).length;
}

async function until(predicate: () => Promise<boolean> | boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return predicate();
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function interactive(prompt: string, extra: Record<string, unknown> = {}, writer: Record<string, unknown> = {}) {
  return queryCodex(prompt, {
    cwd: directory,
    model: 'gpt-5.6-luna',
    permissionMode: 'bypassPermissions',
    ...extra,
  }, { send() {}, setSessionId() {}, ...writer }, runtimeContext);
}

test.after(async () => {
  stopCodexAppServer();
  closeSessionsWatcher();
  closeConnection();
  delete process.env.VIBESPACE_CODEX_THREAD_IDLE_MS;
  await rm(directory, { recursive: true, force: true });
});

test('an idle interactive thread is unsubscribed after the idle window', async () => {
  let threadId: string | null = null;
  await interactive('ok', {}, { setSessionId(id: string) { threadId = id; } });
  assert.ok(threadId);
  assert.equal(await unsubscribed(threadId), 0, 'not released the moment its turn ends');
  assert.ok(await until(async () => (await unsubscribed(threadId!)) === 1), 'released once idle');
  assert.ok(await until(() => !getCodexThreadResidency().some(e => e.threadId === threadId)), 'residency entry dropped');
});

test('a thread is never released while its turn is running', async () => {
  const threadId = 'live-hold';
  const held = interactive('hold', { sessionId: threadId });
  assert.ok(await until(() => isCodexSessionActive(threadId)));
  await sleep(400);
  assert.equal(await unsubscribed(threadId), 0, 'a running turn pins its thread past the idle window');
  assert.ok(await until(() => abortCodexSession(threadId)));
  await held;
  assert.ok(await until(async () => (await unsubscribed(threadId)) === 1), 'released after the cancelled turn went idle');
});

test('a new turn inside the idle window cancels the pending release', async () => {
  const threadId = 'live-again';
  await interactive('ok', { sessionId: threadId });
  await sleep(50);
  await interactive('ok', { sessionId: threadId });
  await sleep(120);
  assert.equal(await unsubscribed(threadId), 0, 'the first turn\'s timer was cancelled by the second');
  assert.ok(await until(async () => (await unsubscribed(threadId)) === 1));
  await sleep(300);
  assert.equal(await unsubscribed(threadId), 1, 'released exactly once');
});

test('a history read and a turn on one thread: released only after both end', async () => {
  const threadId = 'live-shared';
  markCodexRevertedHistory(threadId);
  const started = Date.now();
  const read = readCodexRevertedHistory(threadId, false);
  await sleep(30);
  await interactive('ok', { sessionId: threadId });
  // Had the finished turn armed the timer, the release would land ~150 ms after it.
  await sleep(Math.max(0, 330 - (Date.now() - started)));
  assert.equal(await unsubscribed(threadId), 0, 'the in-flight read still pins the thread');
  assert.deepEqual(await read, []);
  assert.ok(await until(async () => (await unsubscribed(threadId)) === 1));
});
