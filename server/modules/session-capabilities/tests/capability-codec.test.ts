import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import { decodeSessionCapability, decodeSideCapability, encodeSessionCapability, encodeSideCapability } from '../capability-codec.js';

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
  const old = createHmac('sha256', 'secret').update('legacy-session-capability:v1:one').digest('base64url');
  const signedLong = createHmac('sha256', 'secret').update('vibespace:session-capability:v2:one:1800000000:1800000901').digest('base64url');
  for (const input of [old, token.replace('1800000900', '1800000901'), `v2.1800000000.1800000901.${signedLong}`,
    token.replace('1800000000', '01800000000'), token.replace('v2.', 'v1.'), token + '\n',
    'é'.repeat(43), 'x'.repeat(100_000), [], null, undefined, 42, {}]) {
    assert.doesNotThrow(() => assert.equal(decodeSessionCapability('one', input, 'secret', now), null));
  }
  assert.equal(decodeSessionCapability('../one', token, 'secret', now), null);
  assert.throws(() => encodeSessionCapability('../one', 'secret', now));
});

test('owner and side credentials are signed in their own vibespace domains', () => {
  const sign = (input: string) => createHmac('sha256', 'secret').update(input).digest('base64url');
  const owner = encodeSessionCapability('one', 'secret', now);
  assert.equal(owner, `v2.1800000000.1800000900.${sign('vibespace:session-capability:v2:one:1800000000:1800000900')}`);
  const side = encodeSideCapability('one', 'secret', now);
  assert.equal(side, `side1.1800000000.1800086400.${sign('vibespace:side-session-capability:v1:one:1800000000:1800086400')}`);
  assert.equal(decodeSideCapability('one', side, 'secret', now), now + 86_400_000);
  // A token of the same grammar signed under any other domain is refused.
  const foreign = `v2.1800000000.1800000900.${sign('example-domain:session:v2:one:1800000000:1800000900')}`;
  assert.equal(decodeSessionCapability('one', foreign, 'secret', now), null);
  const foreignSide = `side1.1800000000.1800086400.${sign('example-domain:side-session:v1:one:1800000000:1800086400')}`;
  assert.equal(decodeSideCapability('one', foreignSide, 'secret', now), null);
});
