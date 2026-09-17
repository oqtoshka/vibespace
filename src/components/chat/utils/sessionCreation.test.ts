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

test('plugin-declared launch options ride on the creation request, and are absent otherwise', () => {
  assert.deepEqual(buildSessionCreationRequest({
    provider: 'claude',
    projectPath: '/workspace/project',
    isPrivate: false,
    launchOptions: { 'acme.review': true },
    initialMessage: 'Ship it',
  }), {
    provider: 'claude',
    projectPath: '/workspace/project',
    private: false,
    launchOptions: { 'acme.review': true },
    initialMessage: 'Ship it',
  });
  for (const launchOptions of [undefined, null, {}]) {
    assert.equal('launchOptions' in buildSessionCreationRequest({
      provider: 'claude', projectPath: '/p', isPrivate: true, initialMessage: 'x', launchOptions,
    }), false);
  }
});
