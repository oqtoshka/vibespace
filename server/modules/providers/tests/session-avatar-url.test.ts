import assert from 'node:assert/strict';
import test from 'node:test';

import { sessionAvatarUrl } from '@/shared/utils.js';

test('builds the Mission Control avatar URL from the provider-native session id', () => {
  assert.equal(
    sessionAvatarUrl('provider/id with spaces', false),
    'https://mc.dudin.net/avatars/provider%2Fid%20with%20spaces',
  );
});

test('private and not-yet-bound sessions do not advertise an avatar', () => {
  assert.equal(sessionAvatarUrl('provider-id', true), null);
  assert.equal(sessionAvatarUrl(null, false), null);
});
