import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { scopeNativeCommand, validNativeCapability } from '../services/native-chat-policy.service.js';

test('native capability binds one session and rejects malformed/other-session credentials', () => {
  const token = createHmac('sha256', 'fixture').update('mission-control:vibespace-session:v1:one').digest('base64url');
  assert.equal(validNativeCapability('one', token, 'fixture'), true);
  assert.equal(validNativeCapability('two', token, 'fixture'), false);
  assert.equal(validNativeCapability('one', [token], 'fixture'), false);
  assert.equal(validNativeCapability('../one', token, 'fixture'), false);
  assert.equal(validNativeCapability('one', 'bad', 'fixture'), false);
});
test('native commands cannot target other sessions or inject runtime options', () => {
  assert.throws(() => scopeNativeCommand({ type: 'chat.abort', sessionId: 'other' }, 'one'));
  assert.throws(() => scopeNativeCommand({ type: 'files.watch', path: '/etc/passwd' }, 'one'));
  assert.throws(() => scopeNativeCommand({ type: 'chat.send', content: 'hello' }, 'one'));
  const command = scopeNativeCommand({ type: 'chat.send', content: 'hello', clientMsgId: 'x', options: { cwd: '/tmp', permissionMode: 'bypassPermissions' } }, 'one');
  assert.deepEqual(command, { type: 'chat.send', sessionId: 'one', content: 'hello', clientMsgId: 'x' });
  assert.deepEqual(scopeNativeCommand({ type: 'chat.subscribe', sessions: [{ sessionId: 'other' }] }, 'one'), { type: 'chat.subscribe', sessions: [{ sessionId: 'one', lastSeq: 0 }] });
});
