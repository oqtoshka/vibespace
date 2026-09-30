import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { WebSocket } from 'ws';

import { handleShellConnection } from '@/modules/websocket/services/shell-websocket.service.js';

function createFakeSocket() {
  const socket = new EventEmitter() as EventEmitter & {
    readyState: number;
    frames: string[];
    send: (data: string) => void;
  };
  socket.readyState = WebSocket.OPEN;
  socket.frames = [];
  socket.send = (data: string) => socket.frames.push(data);
  return socket;
}

function createFakePty() {
  let dataListener: ((data: string) => void) | null = null;
  let exitListener: ((event: { exitCode: number; signal?: number }) => void) | null = null;

  return {
    killed: false,
    signals: [] as string[],
    onData(listener: (data: string) => void) {
      dataListener = listener;
      return { dispose: () => undefined };
    },
    onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
      exitListener = listener;
      return { dispose: () => undefined };
    },
    emitData(data: string) {
      dataListener?.(data);
    },
    emitExit() {
      exitListener?.({ exitCode: 0 });
    },
    write() {},
    resize() {},
    kill(signal?: string) {
      this.killed = true;
      this.signals.push(signal ?? 'SIGHUP');
    },
  };
}

test('a stale socket close cannot detach the socket that replaced it', () => {
  const pty = createFakePty();
  const dependencies = {
    resolveProviderSessionId: () => null,
    spawnPty: () => pty as never,
  };
  const initMessage = JSON.stringify({
    type: 'init',
    projectPath: process.cwd(),
    sessionId: `stale-close-${Date.now()}`,
    hasSession: false,
    provider: 'plain-shell',
    isPlainShell: true,
    initialCommand: 'test-command',
  });

  const firstSocket = createFakeSocket();
  handleShellConnection(firstSocket as never, dependencies);
  firstSocket.emit('message', initMessage);

  const replacementSocket = createFakeSocket();
  handleShellConnection(replacementSocket as never, dependencies);
  replacementSocket.emit('message', initMessage);
  replacementSocket.frames.length = 0;

  // This ordering reproduces a delayed close from a backgrounded mobile tab.
  firstSocket.emit('close');
  pty.emitData('output-after-stale-close');

  assert.equal(pty.killed, false);
  assert.equal(replacementSocket.frames.length, 1);
  assert.match(replacementSocket.frames[0], /output-after-stale-close/);

  pty.emitExit();
});

test('shell output detects and normalizes a wrapped authentication URL', () => {
  const pty = createFakePty();
  const socket = createFakeSocket();
  const dependencies = {
    resolveProviderSessionId: () => null,
    spawnPty: () => pty as never,
  };

  handleShellConnection(socket as never, dependencies);
  socket.emit(
    'message',
    JSON.stringify({
      type: 'init',
      projectPath: process.cwd(),
      sessionId: `wrapped-url-${Date.now()}`,
      hasSession: false,
      provider: 'plain-shell',
      isPlainShell: true,
      initialCommand: 'test-command',
    })
  );
  socket.frames.length = 0;

  pty.emitData("Continue in your browser: https://example.com/authorize?\ncode=abc\x1b[0m");

  const frames = socket.frames.map((frame) => JSON.parse(frame) as Record<string, unknown>);
  const authenticationFrame = frames.find((frame) => frame.type === 'auth_url');
  assert.deepEqual(authenticationFrame, {
    type: 'auth_url',
    url: 'https://example.com/authorize?code=abc',
    autoOpen: false,
  });

  pty.emitExit();
});

function initMessage(sessionId: string) {
  return JSON.stringify({
    type: 'init',
    projectPath: process.cwd(),
    sessionId,
    hasSession: false,
    provider: 'plain-shell',
    isPlainShell: true,
    initialCommand: 'test-command',
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('re-init on one socket detaches the previous PTY so its idle timeout still fires', async () => {
  const ptys = [createFakePty(), createFakePty()];
  let spawned = 0;
  const socket = createFakeSocket();
  handleShellConnection(socket as never, {
    resolveProviderSessionId: () => null,
    spawnPty: () => ptys[spawned++] as never,
    ptySessionTimeoutMs: 30,
    ptyKillGraceMs: 30,
  });

  const stamp = Date.now();
  socket.emit('message', initMessage(`reinit-a-${stamp}`));
  socket.emit('message', initMessage(`reinit-b-${stamp}`));
  assert.equal(spawned, 2);

  await sleep(60);
  assert.equal(ptys[0].killed, true, 'the abandoned PTY is reaped by its idle timeout');
  assert.equal(ptys[1].killed, false, 'the PTY the socket still owns stays');

  // The old PTY exiting late must not remove the socket's current session.
  ptys[0].emitExit();
  socket.frames.length = 0;
  ptys[1].emitData('still-attached');
  assert.equal(socket.frames.length, 1);
  assert.match(socket.frames[0], /still-attached/);

  socket.emit('message', JSON.stringify({ type: 'kill' }));
  ptys[1].emitExit();
});

test('kill escalates to SIGKILL when the PTY ignores SIGHUP, and not after it exits', async () => {
  const stubborn = createFakePty();
  const polite = createFakePty();
  const queue = [stubborn, polite];
  const socket = createFakeSocket();
  handleShellConnection(socket as never, {
    resolveProviderSessionId: () => null,
    spawnPty: () => queue.shift() as never,
    ptyKillGraceMs: 30,
  });

  const stamp = Date.now();
  socket.emit('message', initMessage(`kill-stubborn-${stamp}`));
  socket.emit('message', JSON.stringify({ type: 'kill' }));
  socket.emit('message', initMessage(`kill-polite-${stamp}`));
  socket.emit('message', JSON.stringify({ type: 'kill' }));
  polite.emitExit();

  await sleep(60);
  assert.deepEqual(stubborn.signals, ['SIGHUP', 'SIGKILL']);
  assert.deepEqual(polite.signals, ['SIGHUP']);
  stubborn.emitExit();
});
