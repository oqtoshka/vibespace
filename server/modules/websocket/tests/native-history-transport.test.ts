import assert from 'node:assert/strict';
import test from 'node:test';
import { sendNativeHistory } from '../services/native-history-transport.service.js';

test('image-heavy history crosses the 12 MiB edge limit without losing bytes or order', async () => {
  const payload = { kind: 'native.history', requestId: 'history', messages: [
    { content: 'Картинка 👋', images: [{ data: 'A'.repeat(14 * 1024 * 1024) }] },
  ] };
  const frames: string[] = [];
  let writing = false;
  const socket = { readyState: 1, send(raw: string, callback: (error?: Error) => void) {
    assert.equal(writing, false, 'wait for each write before scheduling the next chunk');
    writing = true; frames.push(raw);
    setImmediate(() => { writing = false; callback(); });
  } };
  await sendNativeHistory(socket as never, payload, true);
  assert.ok(frames.length > 12);
  assert.ok(frames.every(frame => Buffer.byteLength(frame) < 2 * 1024 * 1024));
  const chunks = frames.map(frame => JSON.parse(frame));
  chunks.forEach((chunk, index) => {
    assert.equal(chunk.index, index); assert.equal(chunk.count, chunks.length);
    assert.equal(chunk.transferId, chunks[0].transferId);
  });
  assert.deepEqual(JSON.parse(Buffer.concat(chunks.map(chunk => Buffer.from(chunk.data, 'base64'))).toString()), payload);
  frames.length = 0;
  await sendNativeHistory(socket as never, { kind: 'native.history', messages: [] }, false);
  assert.equal(JSON.parse(frames[0]).kind, 'native.history', 'ordinary pages preserve the old wire format');
});

test('disconnected history writes reject promptly', async () => {
  await assert.rejects(sendNativeHistory({ readyState: 3 } as never, {}, true), /disconnected/);
});
