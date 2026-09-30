import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// A side question's first Codex turn forks the parent's thread (Mission Control
// threads, side-questions.md "Parent context"). These run queryCodex against a fake
// app-server that records every request, so they pin the exact fork call and the
// excerpt fallback without a real model. The database must exist before import.
const previousDatabasePath = process.env.DATABASE_PATH;
const databaseRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-side-fork-db-'));
process.env.DATABASE_PATH = path.join(databaseRoot, 'auth.db');

const { closeConnection } = await import('./modules/database/connection.js');
const { initializeDatabase } = await import('./modules/database/init-db.js');
const { queryCodex } = await import('./openai-codex.js');
const { stopCodexAppServer } = await import('./services/codex-app-server.service.js');

test.before(() => initializeDatabase());
test.after(async () => {
  closeConnection();
  if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previousDatabasePath;
  await rm(databaseRoot, { recursive: true, force: true });
});

// thread/fork answers with a new thread id, except for the parent 'gone-parent',
// which it refuses the way a real app-server refuses an unknown rollout.
async function createFakeCodex(scriptPath) {
  await writeFile(scriptPath, `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const capturePath = process.env.VIBESPACE_CODEX_CAPTURE;
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const record = (value) => fs.appendFileSync(capturePath, JSON.stringify(value) + '\\n');
let turnCounter = 0;
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method) record(message);
  switch (message.method) {
    case 'initialize':
      send({ id: message.id, result: { userAgent: 'fake' } });
      break;
    case 'thread/start':
      send({ id: message.id, result: { thread: { id: 'fresh-thread' } } });
      break;
    case 'thread/fork':
      if (message.params.threadId === 'gone-parent') {
        send({ id: message.id, error: { code: -32600, message: 'no rollout found for thread id gone-parent' } });
      } else {
        send({ id: message.id, result: { thread: { id: 'forked-thread' }, sandbox: { type: 'readOnly' }, approvalPolicy: 'never' } });
      }
      break;
    case 'thread/resume':
      send({ id: message.id, result: { thread: { id: message.params.threadId } } });
      break;
    case 'config/read':
      send({ id: message.id, result: { config: {} } });
      break;
    case 'thread/unsubscribe':
      send({ id: message.id, result: { status: 'unsubscribed' } });
      break;
    case 'turn/start': {
      const turnId = 'turn-' + (++turnCounter);
      const threadId = message.params.threadId;
      send({ id: message.id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } });
      send({ method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress', items: [] } } });
      send({ method: 'item/completed', params: { threadId, turnId, completedAtMs: Date.now(),
        item: { id: 'assistant-' + turnId, type: 'agentMessage', text: 'Side answer.' } } });
      send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed', items: [] } } });
      break;
    }
  }
});
`, 'utf8');
  await chmod(scriptPath, 0o755);
}

async function runSideTurn(command, options) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-side-fork-'));
  const executable = path.join(tempRoot, 'fake-codex');
  const capturePath = path.join(tempRoot, 'requests.jsonl');
  const previousPath = process.env.VIBESPACE_CODEX_PATH;
  const previousCapture = process.env.VIBESPACE_CODEX_CAPTURE;
  const messages = [];
  const writer = {
    isWebSocketWriter: true,
    sessionId: null,
    send(message) { messages.push(message); },
    setSessionId(sessionId) { this.sessionId = sessionId; },
  };
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  try {
    await createFakeCodex(executable);
    process.env.VIBESPACE_CODEX_PATH = executable;
    process.env.VIBESPACE_CODEX_CAPTURE = capturePath;
    await queryCodex(command, {
      cwd: tempRoot,
      model: 'gpt-5.4',
      permissionMode: 'plan',
      private: true,
      sideSession: true,
      ...options,
    }, writer);
    const requests = (await readFile(capturePath, 'utf8'))
      .trim().split('\n').map((line) => JSON.parse(line));
    return { requests, messages, warnings, tempRoot };
  } finally {
    console.warn = originalWarn;
    stopCodexAppServer();
    if (previousPath === undefined) delete process.env.VIBESPACE_CODEX_PATH;
    else process.env.VIBESPACE_CODEX_PATH = previousPath;
    if (previousCapture === undefined) delete process.env.VIBESPACE_CODEX_CAPTURE;
    else process.env.VIBESPACE_CODEX_CAPTURE = previousCapture;
    await rm(tempRoot, { recursive: true, force: true });
  }
}

test('a Codex side question forks the parent thread read-only and runs its turn on the fork', async () => {
  const { requests, messages, tempRoot } = await runSideTurn('What did we decide?', {
    forkFrom: 'parent-thread',
    sideExcerptFallback: 'PARENT EXCERPT',
  });

  const fork = requests.find((request) => request.method === 'thread/fork');
  // `config` carries the per-model compaction overrides every thread gets; not fork-specific.
  const { config: _config, ...forkParams } = fork?.params ?? {};
  assert.deepEqual(forkParams, {
    threadId: 'parent-thread',
    cwd: tempRoot,
    model: 'gpt-5.4',
    sandbox: 'read-only',
    approvalPolicy: 'never',
    excludeTurns: true,
  });
  assert.equal(requests.some((request) => request.method === 'thread/start'), false);
  assert.equal(requests.some((request) => request.method === 'thread/resume'), false,
    'the parent thread must not be resumed or otherwise touched');

  const turn = requests.find((request) => request.method === 'turn/start');
  assert.equal(turn?.params.threadId, 'forked-thread');
  assert.deepEqual(turn?.params.input, [{ type: 'text', text: 'What did we decide?' }],
    'a forked side carries the parent in its history, so the prompt gets no excerpt');

  const created = messages.find((message) => message.kind === 'session_created');
  assert.equal(created?.newSessionId, 'forked-thread');
  assert.ok(messages.some((message) => message.kind === 'text' && message.content === 'Side answer.'));
});

test('a refused Codex fork falls back to a fresh read-only thread quoting the parent excerpt', async () => {
  const { requests, messages, warnings } = await runSideTurn('What did we decide?', {
    forkFrom: 'gone-parent',
    sideExcerptFallback: 'PARENT EXCERPT',
  });

  assert.ok(requests.some((request) => request.method === 'thread/fork'));
  const start = requests.find((request) => request.method === 'thread/start');
  assert.equal(start?.params.sandbox, 'read-only');
  assert.equal(start?.params.approvalPolicy, 'never');

  const turn = requests.find((request) => request.method === 'turn/start');
  assert.equal(turn?.params.threadId, 'fresh-thread');
  assert.equal(turn?.params.input[0].text, 'PARENT EXCERPT\nWhat did we decide?');
  assert.equal(messages.find((message) => message.kind === 'session_created')?.newSessionId, 'fresh-thread');
  assert.ok(warnings.some((line) => line.includes('thread/fork of gone-parent failed')));
});

test('a Codex side without forkFrom, or an already started side, never forks', async () => {
  const fresh = await runSideTurn('Fresh side', {});
  assert.equal(fresh.requests.some((request) => request.method === 'thread/fork'), false);
  assert.ok(fresh.requests.some((request) => request.method === 'thread/start'));

  const resumed = await runSideTurn('Follow-up', { sessionId: 'forked-thread', forkFrom: 'parent-thread' });
  assert.equal(resumed.requests.some((request) => request.method === 'thread/fork'), false);
  assert.equal(resumed.requests.find((request) => request.method === 'thread/resume')?.params.threadId, 'forked-thread');
});
