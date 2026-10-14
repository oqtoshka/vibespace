import assert from 'node:assert/strict';
import test from 'node:test';

import { NATIVE_OUTBOX_OVERFLOW_CLOSE_CODE, NativeOutbox } from '../services/native-outbox.service.js';
import { sendNativeHistory } from '../services/native-history-transport.service.js';

const MiB = 1024 * 1024;

/** A socket whose buffer the test controls; frames count as written when sent. */
class Socket {
  readyState = 1;
  bufferedAmount = 0;
  frames: string[] = [];
  closed: { code: number; reason: string } | null = null;
  send(data: string, callback?: (error?: Error) => void) {
    this.frames.push(data); this.bufferedAmount += Buffer.byteLength(data); callback?.();
  }
  close(code: number, reason: string) { this.closed = { code, reason }; this.readyState = 3; }
}

/** Read through a function so TypeScript does not keep an earlier null narrowing. */
const closedOf = (socket: Socket) => socket.closed;
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('a full socket buffer queues frames in order and drains them instead of dropping', async () => {
  const socket = new Socket();
  const outbox = new NativeOutbox(socket as never, { highWaterBytes: 12 * MiB, maxQueuedBytes: 64 * MiB, stallMs: 5_000, pollMs: 5 });
  // A 6.3 MB history page, then another page and the terminal frame while the buffer is still full.
  const page = JSON.stringify({ kind: 'native.history', blob: 'x'.repeat(6.3 * 1024 * 1024) });
  outbox.send(page);
  outbox.send(page);
  assert.equal(socket.frames.length, 2, 'below the high-water mark frames go straight through');
  const delivered: string[] = [];
  outbox.send(JSON.stringify({ kind: 'stream_delta' }), error => { assert.ifError(error); delivered.push('delta'); });
  outbox.send(JSON.stringify({ kind: 'complete' }), error => { assert.ifError(error); delivered.push('complete'); });
  assert.equal(socket.frames.length, 2, 'above the mark frames wait instead of being sent or dropped');
  await wait(30);
  assert.equal(socket.frames.length, 2);
  socket.bufferedAmount = 0; // the client read the pages
  await wait(30);
  assert.deepEqual(socket.frames.slice(2).map(frame => JSON.parse(frame).kind), ['stream_delta', 'complete']);
  assert.deepEqual(delivered, ['delta', 'complete']);
  assert.equal(socket.closed, null);

  // History written through the outbox keeps its place behind queued frames.
  socket.bufferedAmount = 13 * MiB;
  outbox.send(JSON.stringify({ kind: 'before-history' }));
  const history = sendNativeHistory({ get readyState() { return socket.readyState as 1; }, send: (data, callback) => outbox.send(data, callback) },
    { kind: 'native.history', messages: [] }, false);
  outbox.send(JSON.stringify({ kind: 'after-history' }));
  await wait(20);
  socket.bufferedAmount = 0;
  await history;
  await wait(20);
  assert.deepEqual(socket.frames.slice(4).map(frame => JSON.parse(frame).kind), ['before-history', 'native.history', 'after-history']);
  outbox.dispose();
});

test('a slowly draining buffer is progress, not a stall', async () => {
  const socket = new Socket();
  socket.bufferedAmount = 10 * MiB;
  const outbox = new NativeOutbox(socket as never, { highWaterBytes: 8 * MiB, stallMs: 60, pollMs: 5 });
  outbox.send('{"kind":"complete"}');
  for (let step = 0; step < 10; step++) { await wait(20); socket.bufferedAmount -= 100_000; }
  assert.equal(socket.closed, null, '200 ms of slow draining with a 60 ms stall window does not close');
  socket.bufferedAmount = 0;
  await wait(20);
  assert.equal(socket.frames.at(-1), '{"kind":"complete"}');
  outbox.dispose();
});

test('a backlog over its byte bound closes the socket with a reconnect code instead of losing frames silently', async () => {
  const socket = new Socket();
  socket.bufferedAmount = 20 * MiB;
  const outbox = new NativeOutbox(socket as never, { highWaterBytes: 12 * MiB, maxQueuedBytes: 1 * MiB, stallMs: 5_000, pollMs: 5 });
  const errors: string[] = [];
  outbox.send('x'.repeat(600 * 1024), error => errors.push(error?.message ?? 'ok'));
  assert.equal(socket.closed, null);
  outbox.send('y'.repeat(600 * 1024), error => errors.push(error?.message ?? 'ok'));
  assert.equal(closedOf(socket)?.code, NATIVE_OUTBOX_OVERFLOW_CLOSE_CODE);
  assert.match(closedOf(socket)!.reason, /reconnect/);
  assert.ok(Buffer.byteLength(closedOf(socket)!.reason) <= 123, 'a WebSocket close reason fits in 123 bytes');
  assert.deepEqual(errors, ['Chat disconnected', 'Chat disconnected'], 'waiting writers are released with an error');
  assert.equal(socket.frames.length, 0);
  // Later frames on the closed outbox fail fast rather than queueing forever.
  let late: Error | undefined;
  outbox.send('{}', error => { late = error; });
  assert.match(String(late?.message), /disconnected/);
});

test('a buffer that never drains closes the socket after the stall window', async () => {
  const socket = new Socket();
  socket.bufferedAmount = 20 * MiB;
  const outbox = new NativeOutbox(socket as never, { highWaterBytes: 12 * MiB, stallMs: 50, pollMs: 5 });
  outbox.send('{"kind":"complete"}');
  await wait(30);
  assert.equal(socket.closed, null);
  await wait(80);
  assert.equal(closedOf(socket)?.code, NATIVE_OUTBOX_OVERFLOW_CLOSE_CODE);
  assert.equal(socket.frames.length, 0);
});

test('a socket closed by the peer releases queued writers and stops polling', async () => {
  const socket = new Socket();
  socket.bufferedAmount = 20 * MiB;
  const outbox = new NativeOutbox(socket as never, { highWaterBytes: 12 * MiB, stallMs: 5_000, pollMs: 5 });
  let error: Error | undefined;
  outbox.send('{}', value => { error = value; });
  socket.readyState = 3;
  await wait(20);
  assert.match(String(error?.message), /disconnected/);
  assert.equal(socket.closed, null, 'an already closed socket is not closed again');
});
