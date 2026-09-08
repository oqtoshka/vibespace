import assert from 'node:assert/strict';
import { test } from 'node:test';
import { providerPolicy } from '../services/provider-policy.service.js';

test('operator allow-list rejects every disabled harness and invalid configuration', () => {
  const previous = process.env.VS_ENABLED_PROVIDERS;
  try {
    process.env.VS_ENABLED_PROVIDERS = 'opencode';
    assert.deepEqual(providerPolicy.enabled(), ['opencode']);
    providerPolicy.assertEnabled('opencode');
    for (const provider of ['claude', 'codex', 'cursor', 'bogus']) {
      assert.throws(() => providerPolicy.assertEnabled(provider), /disabled/);
    }
    process.env.VS_ENABLED_PROVIDERS = '';
    assert.throws(() => providerPolicy.enabled(), /Invalid/);
    process.env.VS_ENABLED_PROVIDERS = 'opencode,typo';
    assert.throws(() => providerPolicy.enabled(), /Invalid/);
    delete process.env.VS_ENABLED_PROVIDERS;
    assert.equal(providerPolicy.enabled().length, 4);
  } finally {
    if (previous === undefined) delete process.env.VS_ENABLED_PROVIDERS;
    else process.env.VS_ENABLED_PROVIDERS = previous;
  }
});
