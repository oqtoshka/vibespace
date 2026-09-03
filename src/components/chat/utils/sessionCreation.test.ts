import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSessionCreationRequest } from './sessionCreation';

test('includes the first prompt so a new session gets an immediate provisional title', () => {
  assert.deepEqual(buildSessionCreationRequest({
    provider: 'codex',
    projectPath: '/workspace/project',
    isPrivate: false,
    initialMessage: 'Add session deep links',
  }), {
    provider: 'codex',
    projectPath: '/workspace/project',
    private: false,
    initialMessage: 'Add session deep links',
  });
});
