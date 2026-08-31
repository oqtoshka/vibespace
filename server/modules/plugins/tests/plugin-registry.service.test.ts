import assert from 'node:assert/strict';
import test from 'node:test';

import { validateManifest } from '@/modules/plugins/index.js';

const baseManifest = {
  name: 'example',
  displayName: 'Example',
  hostModule: 'host/index.js',
};

test('accepts a same-origin plugin session action with a session placeholder', () => {
  assert.deepEqual(validateManifest({
    ...baseManifest,
    sessionActions: [{
      id: 'open-board',
      label: 'Open on board',
      endpoint: '/api/example/sessions/{sessionId}/card',
    }],
  }), { valid: true });
});

test('rejects session actions that could fetch another origin or cannot identify a session', () => {
  for (const endpoint of [
    'https://example.test/session/{sessionId}',
    '//example.test/session/{sessionId}',
    '/api/example/session',
  ]) {
    const result = validateManifest({
      ...baseManifest,
      sessionActions: [{ id: 'open-board', label: 'Open on board', endpoint }],
    });
    assert.equal(result.valid, false);
    assert.match(String(result.error), /same-origin path/);
  }
});
