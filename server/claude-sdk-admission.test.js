import assert from 'node:assert/strict';
import test from 'node:test';

import { queryClaudeSDK, abortClaudeSDKSession, __setClaudeQueryImpl } from './claude-sdk.js';

// A turn-admission reservation (a host cleanup holding the session for a few
// seconds) refuses the background auto-resume run. The resume must wait for the
// reservation to end and then run under its own run: neither dropped, nor fed
// to the model while the cleanup holds the session.

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function makeWriter() {
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

const assistantText = (text, sessionId) => ({
  type: 'assistant', session_id: sessionId, message: { role: 'assistant', content: [{ type: 'text', text }] },
});
const resultMsg = (sessionId) => ({ type: 'result', subtype: 'success', session_id: sessionId });

function makeFakeQuery(sessionId, captured) {
  return ({ prompt }) => {
    const reader = prompt[Symbol.asyncIterator]();
    const gen = (async function* () {
      await reader.next();
      yield assistantText('launching background poll', sessionId);
      yield { type: 'system', subtype: 'task_started', task_id: 't1', description: 'poll', session_id: sessionId };
      yield resultMsg(sessionId);
      yield {
        type: 'system', subtype: 'task_notification', task_id: 't1', tool_use_id: 'toolu_1',
        status: 'completed', output_file: '/tmp/out.txt', summary: 'host is up', session_id: sessionId,
      };
      captured.notified = true;
      const injected = await reader.next();
      captured.injectedAt = Date.now();
      captured.injected = injected.value;
      yield assistantText('resumed after the cleanup', sessionId);
      yield resultMsg(sessionId);
    })();
    gen.interrupt = async () => {};
    gen.setModel = async () => {};
    gen.setPermissionMode = async () => {};
    return gen;
  };
}

test('a background resume refused by a reservation waits for its end, then runs under its own run', async () => {
  const sessionId = 'admission-deferred-1';
  const captured = {};
  __setClaudeQueryImpl(makeFakeQuery(sessionId, captured));

  let reserved = true;
  let freeResolvers = [];
  let releasedAt = 0;
  const release = () => {
    reserved = false;
    releasedAt = Date.now();
    for (const resolve of freeResolvers) resolve();
    freeResolvers = [];
  };
  const resumeWriter = makeWriter();
  let acquired = 0;
  const writer = makeWriter();

  try {
    await queryClaudeSDK('watch the host', {
      sessionId,
      ephemeral: false,
      acquireResumeRun: () => { acquired += 1; return reserved ? null : resumeWriter; },
      isTurnAdmissionReserved: () => reserved,
      whenTurnAdmissionFree: () => (reserved ? new Promise((resolve) => freeResolvers.push(resolve)) : Promise.resolve()),
    }, writer);

    for (let i = 0; i < 100 && !captured.notified; i += 1) await delay(5);
    assert.ok(captured.notified, 'the background job completed');
    await delay(60);
    assert.equal(captured.injected, undefined, 'held: nothing was fed to the model');
    assert.equal(acquired, 0, 'held: no resume run was opened');
    assert.equal(freeResolvers.length, 1, 'the resume is parked on the reservation');

    release();
    for (let i = 0; i < 100 && !captured.injected; i += 1) await delay(5);
    assert.ok(captured.injected, 'released: the resume was delivered, not dropped');
    assert.match(captured.injected.message.content, /<task-id>t1<\/task-id>/);
    assert.ok(captured.injectedAt >= releasedAt, 'delivered only after the release');
    assert.equal(acquired, 1, 'exactly one resume run');
    for (let i = 0; i < 100 && !resumeWriter.messages.some((m) => JSON.stringify(m).includes('resumed after')); i += 1) await delay(5);
    assert.ok(resumeWriter.messages.some((m) => JSON.stringify(m).includes('resumed after the cleanup')),
      'the resumed turn streams under its own run');
  } finally {
    release();
    await abortClaudeSDKSession(sessionId).catch(() => {});
    __setClaudeQueryImpl(null);
  }
});

test('a reservation taken again before the parked resume wakes re-parks it', async () => {
  const sessionId = 'admission-deferred-2';
  const captured = {};
  __setClaudeQueryImpl(makeFakeQuery(sessionId, captured));

  let reserved = true;
  let freeResolvers = [];
  const wakeAll = () => { const r = freeResolvers; freeResolvers = []; for (const resolve of r) resolve(); };
  const resumeWriter = makeWriter();
  let acquired = 0;

  try {
    await queryClaudeSDK('watch the host', {
      sessionId,
      ephemeral: false,
      acquireResumeRun: () => { acquired += 1; return reserved ? null : resumeWriter; },
      isTurnAdmissionReserved: () => reserved,
      whenTurnAdmissionFree: () => (reserved ? new Promise((resolve) => freeResolvers.push(resolve)) : Promise.resolve()),
    }, makeWriter());

    for (let i = 0; i < 100 && freeResolvers.length === 0; i += 1) await delay(5);
    assert.equal(freeResolvers.length, 1);
    wakeAll(); // woken, but a second reservation already holds the session
    await delay(30);
    assert.equal(captured.injected, undefined, 're-held: still not fed');
    assert.equal(acquired, 0);
    assert.equal(freeResolvers.length, 1, 're-parked on the new reservation');

    reserved = false;
    wakeAll();
    for (let i = 0; i < 100 && !captured.injected; i += 1) await delay(5);
    assert.ok(captured.injected, 'delivered after the second reservation ends');
    assert.equal(acquired, 1);
  } finally {
    reserved = false;
    wakeAll();
    await abortClaudeSDKSession(sessionId).catch(() => {});
    __setClaudeQueryImpl(null);
  }
});
