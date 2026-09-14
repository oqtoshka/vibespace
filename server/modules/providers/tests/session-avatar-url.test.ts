import assert from 'node:assert/strict';
import test from 'node:test';

import { sessionAvatarUrl } from '@/shared/utils.js';

const withAvatarBase = (value: string | undefined, run: () => void) => {
  const previous = process.env.MC_AVATAR_PUBLIC_BASE_URL;
  if (value === undefined) delete process.env.MC_AVATAR_PUBLIC_BASE_URL;
  else process.env.MC_AVATAR_PUBLIC_BASE_URL = value;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env.MC_AVATAR_PUBLIC_BASE_URL;
    else process.env.MC_AVATAR_PUBLIC_BASE_URL = previous;
  }
};

test('builds the Mission Control avatar URL from the provider-native session id', () => {
  withAvatarBase('https://mc.example.com/avatars/', () => {
    assert.equal(
      sessionAvatarUrl('provider/id with spaces', false),
      'https://mc.example.com/avatars/provider%2Fid%20with%20spaces',
    );
  });
});

test('no Mission Control configured means no avatar', () => {
  withAvatarBase(undefined, () => {
    assert.equal(sessionAvatarUrl('provider-id', false), null);
  });
});

test('private and not-yet-bound sessions do not advertise an avatar', () => {
  withAvatarBase('https://mc.example.com/avatars', () => {
    assert.equal(sessionAvatarUrl('provider-id', true), null);
    assert.equal(sessionAvatarUrl(null, false), null);
  });
});
