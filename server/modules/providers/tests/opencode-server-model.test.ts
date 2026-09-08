import assert from 'node:assert/strict';
import test from 'node:test';
import { assertOpenCodeServerModel } from '../services/opencode-server-model.service.js';

test('a nonempty catalog from another provider cannot admit the requested model', () => {
  assert.throws(() => assertOpenCodeServerModel([{ providerID: 'opencode', id: 'large' }], { providerID: 'litellm', id: 'large' }), /model unavailable/);
  assert.throws(() => assertOpenCodeServerModel([], { providerID: 'litellm', id: 'large' }), /model unavailable/);
});
test('the configured provider and exact alias admit the turn', () => {
  assert.doesNotThrow(() => assertOpenCodeServerModel([{ providerID: 'litellm', id: 'large' }], { providerID: 'litellm', id: 'large' }));
});
