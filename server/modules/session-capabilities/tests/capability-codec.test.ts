import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import { decodeSessionCapability, encodeSessionCapability } from '../capability-codec.js';

const now = 1_800_000_000_000;
test('v2 is session/secret bound with strict issue and expiry boundaries', () => {
  const token = encodeSessionCapability('ses_legacy.one-1', 'secret', now);
  assert.equal(decodeSessionCapability('ses_legacy.one-1', token, 'secret', now), now + 900_000);
  assert.equal(decodeSessionCapability('ses_legacy.one-1', token, 'secret', now + 899_999), now + 900_000);
  for (const time of [now - 1, now + 900_000, now + 900_001, NaN]) assert.equal(decodeSessionCapability('ses_legacy.one-1', token, 'secret', time), null);
  assert.equal(decodeSessionCapability('other', token, 'secret', now), null);
  assert.equal(decodeSessionCapability('ses_legacy.one-1', token, 'rotated', now), null);
});

test('v1, malformed bytes, timestamp tampering and overlong lifetime fail closed', () => {
  const token = encodeSessionCapability('one', 'secret', now);
  const old = createHmac('sha256', 'secret').update('mission-control:vibespace-session:v1:one').digest('base64url');
  const signedLong = createHmac('sha256', 'secret').update('mission-control:vibespace-session:v2:one:1800000000:1800000901').digest('base64url');
  for (const input of [old, token.replace('1800000900', '1800000901'), `v2.1800000000.1800000901.${signedLong}`,
    token.replace('1800000000', '01800000000'), token.replace('v2.', 'v1.'), token + '\n',
    'é'.repeat(43), 'x'.repeat(100_000), [], null, undefined, 42, {}]) {
    assert.doesNotThrow(() => assert.equal(decodeSessionCapability('one', input, 'secret', now), null));
  }
  assert.equal(decodeSessionCapability('../one', token, 'secret', now), null);
  assert.throws(() => encodeSessionCapability('../one', 'secret', now));
});
