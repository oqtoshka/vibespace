import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  injectCodexMessage,
  isCodexSessionActive,
  queryCodex,
} from './openai-codex.js';
import { stopCodexAppServer } from './services/codex-app-server.service.js';
import {
  __clearTaskContinuationState,
  __setTaskLedgerReader,
} from './services/task-continuation.js';

async function waitFor(check, message) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

async function createFakeCodex(scriptPath) {
  await writeFile(scriptPath, `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const capturePath = process.env.VIBESPACE_CODEX_CAPTURE;
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const record = (value) => fs.appendFileSync(capturePath, JSON.stringify(value) + '\\n');
let turnCounter = 0;
let activeTurnId = null;

rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method) record(message);
  switch (message.method) {
    case 'initialize':
      send({ id: message.id, result: { userAgent: 'fake' } });
      break;
    case 'initialized':
      break;
    case 'thread/start':
      send({ id: message.id, result: { thread: { id: 'codex-thread-1' } } });
      break;
    case 'thread/resume':
      send({ id: message.id, result: { thread: { id: message.params.threadId } } });
      break;
    case 'turn/start':
      activeTurnId = 'turn-' + (++turnCounter);
      send({ id: message.id, result: { turn: { id: activeTurnId, status: 'inProgress', items: [] } } });
      send({ method: 'turn/started', params: {
        threadId: message.params.threadId,
        turn: { id: activeTurnId, status: 'inProgress', items: [] },
      } });
      if (message.params.input?.some((item) => item.text === 'Write recap JSON.')) {
        send({ method: 'item/completed', params: {
          threadId: message.params.threadId,
          turnId: activeTurnId,
          completedAtMs: Date.now(),
          item: {
            id: 'assistant-recap',
            type: 'agentMessage',
            text: '{"title":"Codex Recaps","recap":"Codex now generates recaps."}',
          },
        } });
        send({ method: 'turn/completed', params: {
          threadId: message.params.threadId,
          turn: { id: activeTurnId, status: 'completed', items: [] },
        } });
      } else if (message.params.input?.some((item) =>
        item.text === 'Complete immediately.'
          || item.text === 'Fail with work open.'
          || item.text.startsWith('[session supervisor]')
      )) {
        const failedWithOpenWork = message.params.input.some(
          (item) => item.text === 'Fail with work open.'
        );
        send({ method: 'item/completed', params: {
          threadId: message.params.threadId,
          turnId: activeTurnId,
          completedAtMs: Date.now(),
          item: {
            id: 'assistant-' + activeTurnId,
            type: 'agentMessage',
            text: turnCounter === 1 ? 'Stopped with work open.' : 'Continuation finished.',
          },
        } });
        send({ method: 'turn/completed', params: {
          threadId: message.params.threadId,
          turn: {
            id: activeTurnId,
            status: failedWithOpenWork ? 'failed' : 'completed',
            error: failedWithOpenWork ? { message: 'synthetic turn failure' } : undefined,
            items: [],
          },
        } });
      }
      break;
    case 'turn/steer':
      send({ id: message.id, result: { turnId: activeTurnId } });
      send({ method: 'item/started', params: {
        threadId: message.params.threadId,
        turnId: activeTurnId,
        startedAtMs: Date.now(),
        item: {
          id: 'user-2',
          type: 'userMessage',
          clientId: message.params.clientUserMessageId,
          content: message.params.input,
        },
      } });
      send({ method: 'item/completed', params: {
        threadId: message.params.threadId,
        turnId: activeTurnId,
        completedAtMs: Date.now(),
        item: { id: 'assistant-1', type: 'agentMessage', text: 'Steering received.' },
      } });
      send({ method: 'thread/tokenUsage/updated', params: {
        threadId: message.params.threadId,
        turnId: activeTurnId,
        tokenUsage: {
          last: { totalTokens: 12, inputTokens: 9, cachedInputTokens: 0, outputTokens: 3, reasoningOutputTokens: 0 },
          total: { totalTokens: 30, inputTokens: 24, cachedInputTokens: 0, outputTokens: 6, reasoningOutputTokens: 0 },
          modelContextWindow: 200000,
        },
      } });
      send({ method: 'turn/completed', params: {
        threadId: message.params.threadId,
        turn: { id: activeTurnId, status: 'completed', items: [] },
      } });
      break;
  }
});
`, 'utf8');
  await chmod(scriptPath, 0o755);
}

test('Codex messages sent mid-turn use turn/steer and render as a live user turn', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-steering-'));
  const executable = path.join(tempRoot, 'fake-codex');
  const capturePath = path.join(tempRoot, 'requests.jsonl');
  const previousPath = process.env.VIBESPACE_CODEX_PATH;
  const previousCapture = process.env.VIBESPACE_CODEX_CAPTURE;
  const messages = [];
  const writer = {
    isWebSocketWriter: true,
    sessionId: null,
    send(message) {
      messages.push(message);
    },
    setSessionId(sessionId) {
      this.sessionId = sessionId;
    },
  };

  try {
    await createFakeCodex(executable);
    process.env.VIBESPACE_CODEX_PATH = executable;
    process.env.VIBESPACE_CODEX_CAPTURE = capturePath;

    const runningQuery = queryCodex('Start the task', {
      cwd: tempRoot,
      model: 'gpt-5.4',
      permissionMode: 'acceptEdits',
    }, writer);

    await waitFor(
      () => isCodexSessionActive('codex-thread-1'),
      'the fake Codex turn never became active',
    );

    let delivered = 0;
    const injectedId = await injectCodexMessage('codex-thread-1', 'Focus on tests first.', {
      clientUserMessageId: 'queued-1',
      cwd: tempRoot,
      onDelivered: () => { delivered += 1; },
    });
    await runningQuery;

    assert.equal(injectedId, 'queued-1');
    assert.equal(delivered, 1);
    assert.equal(writer.sessionId, 'codex-thread-1');

    const userMessage = messages.find((message) =>
      message.kind === 'text' && message.role === 'user' && message.content === 'Focus on tests first.',
    );
    assert.equal(userMessage?.id, 'queued-1');
    assert.ok(messages.some((message) =>
      message.kind === 'text' && message.role === 'assistant' && message.content === 'Steering received.',
    ));
    assert.ok(
      messages.indexOf(userMessage) < messages.findIndex((message) => message.content === 'Steering received.'),
      'the steered user turn should render before the assistant reacts to it',
    );
    assert.ok(messages.some((message) => message.kind === 'complete' && message.exitCode === 0));

    const requests = (await readFile(capturePath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const steer = requests.find((request) => request.method === 'turn/steer');
    assert.deepEqual(steer?.params, {
      threadId: 'codex-thread-1',
      expectedTurnId: 'turn-1',
      clientUserMessageId: 'queued-1',
      input: [{ type: 'text', text: 'Focus on tests first.' }],
    });
  } finally {
    stopCodexAppServer();
    if (previousPath === undefined) delete process.env.VIBESPACE_CODEX_PATH;
    else process.env.VIBESPACE_CODEX_PATH = previousPath;
    if (previousCapture === undefined) delete process.env.VIBESPACE_CODEX_CAPTURE;
    else process.env.VIBESPACE_CODEX_CAPTURE = previousCapture;
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Codex resumes the same thread while its plan has open tasks', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-continuation-'));
  const executable = path.join(tempRoot, 'fake-codex');
  const capturePath = path.join(tempRoot, 'requests.jsonl');
  const previousPath = process.env.VIBESPACE_CODEX_PATH;
  const previousCapture = process.env.VIBESPACE_CODEX_CAPTURE;
  const messages = [];
  const writer = {
    isWebSocketWriter: true,
    send(message) {
      messages.push(message);
    },
    setSessionId() {},
  };
  let ledgerReads = 0;

  try {
    await createFakeCodex(executable);
    process.env.VIBESPACE_CODEX_PATH = executable;
    process.env.VIBESPACE_CODEX_CAPTURE = capturePath;
    __clearTaskContinuationState();
    __setTaskLedgerReader('codex', () => {
      ledgerReads += 1;
      return ledgerReads === 1
        ? { open: [{ id: '1', subject: 'finish the implementation', status: 'in_progress' }], activity: 1 }
        : { open: [], activity: 2 };
    });

    await queryCodex('Complete immediately.', {
      cwd: tempRoot,
      sessionId: 'codex-thread-1',
      model: 'gpt-5.4',
      permissionMode: 'acceptEdits',
    }, writer);

    const requests = (await readFile(capturePath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const turns = requests.filter((request) => request.method === 'turn/start');
    assert.equal(turns.length, 2, 'one open plan produces exactly one continuation turn');
    assert.equal(turns[0].params.threadId, 'codex-thread-1');
    assert.equal(turns[1].params.threadId, 'codex-thread-1');
    assert.match(turns[1].params.input[0].text, /finish the implementation/);
    assert.ok(messages.some((message) =>
      message.kind === 'status' && message.text === 'Resuming — open tasks remain',
    ));
    assert.equal(
      messages.filter((message) => message.kind === 'complete').length,
      1,
      'the intermediate turn must not emit a terminal completion',
    );
    assert.ok(messages.some((message) =>
      message.kind === 'text' && message.content === 'Continuation finished.',
    ));
  } finally {
    __setTaskLedgerReader('codex', null);
    __clearTaskContinuationState();
    stopCodexAppServer();
    if (previousPath === undefined) delete process.env.VIBESPACE_CODEX_PATH;
    else process.env.VIBESPACE_CODEX_PATH = previousPath;
    if (previousCapture === undefined) delete process.env.VIBESPACE_CODEX_CAPTURE;
    else process.env.VIBESPACE_CODEX_CAPTURE = previousCapture;
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Codex resumes open plan work after a non-user-aborted turn failure', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-failed-continuation-'));
  const executable = path.join(tempRoot, 'fake-codex');
  const capturePath = path.join(tempRoot, 'requests.jsonl');
  const previousPath = process.env.VIBESPACE_CODEX_PATH;
  const previousCapture = process.env.VIBESPACE_CODEX_CAPTURE;
  const messages = [];
  const writer = {
    isWebSocketWriter: true,
    send(message) {
      messages.push(message);
    },
    setSessionId() {},
  };
  let ledgerReads = 0;

  try {
    await createFakeCodex(executable);
    process.env.VIBESPACE_CODEX_PATH = executable;
    process.env.VIBESPACE_CODEX_CAPTURE = capturePath;
    __clearTaskContinuationState();
    __setTaskLedgerReader('codex', () => {
      ledgerReads += 1;
      return ledgerReads === 1
        ? { open: [{ id: '1', subject: 'recover unfinished work', status: 'in_progress' }], activity: 1 }
        : { open: [], activity: 2 };
    });

    await queryCodex('Fail with work open.', {
      cwd: tempRoot,
      sessionId: 'codex-thread-1',
      model: 'gpt-5.4',
      permissionMode: 'acceptEdits',
    }, writer);

    const requests = (await readFile(capturePath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const turns = requests.filter((request) => request.method === 'turn/start');
    assert.equal(turns.length, 2, 'failed work with an open plan must start a continuation turn');
    assert.match(turns[1].params.input[0].text, /recover unfinished work/);
    assert.ok(messages.some((message) =>
      message.kind === 'status' && message.text === 'Resuming — open tasks remain',
    ));
    assert.equal(
      messages.filter((message) => message.kind === 'complete').length,
      1,
      'only the continuation emits the terminal completion',
    );
    assert.ok(!messages.some((message) => message.kind === 'error'));
  } finally {
    __setTaskLedgerReader('codex', null);
    __clearTaskContinuationState();
    stopCodexAppServer();
    if (previousPath === undefined) delete process.env.VIBESPACE_CODEX_PATH;
    else process.env.VIBESPACE_CODEX_PATH = previousPath;
    if (previousCapture === undefined) delete process.env.VIBESPACE_CODEX_CAPTURE;
    else process.env.VIBESPACE_CODEX_CAPTURE = previousCapture;
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Codex helper turns are ephemeral and do not announce a persisted session', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-ephemeral-'));
  const executable = path.join(tempRoot, 'fake-codex');
  const capturePath = path.join(tempRoot, 'requests.jsonl');
  const previousPath = process.env.VIBESPACE_CODEX_PATH;
  const previousCapture = process.env.VIBESPACE_CODEX_CAPTURE;
  const messages = [];
  const writer = {
    isWebSocketWriter: true,
    send(message) {
      messages.push(message);
    },
    setSessionId() {},
  };

  try {
    await createFakeCodex(executable);
    process.env.VIBESPACE_CODEX_PATH = executable;
    process.env.VIBESPACE_CODEX_CAPTURE = capturePath;

    await queryCodex('Write recap JSON.', {
      cwd: tempRoot,
      model: 'gpt-5.4',
      ephemeral: true,
    }, writer);

    const requests = (await readFile(capturePath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const start = requests.find((request) => request.method === 'thread/start');
    assert.equal(start?.params?.ephemeral, true);
    assert.equal(messages.some((message) => message.kind === 'session_created'), false);
    assert.ok(messages.some((message) =>
      message.kind === 'text' && message.content.includes('Codex now generates recaps'),
    ));
  } finally {
    stopCodexAppServer();
    if (previousPath === undefined) delete process.env.VIBESPACE_CODEX_PATH;
    else process.env.VIBESPACE_CODEX_PATH = previousPath;
    if (previousCapture === undefined) delete process.env.VIBESPACE_CODEX_CAPTURE;
    else process.env.VIBESPACE_CODEX_CAPTURE = previousCapture;
    await rm(tempRoot, { recursive: true, force: true });
  }
});
