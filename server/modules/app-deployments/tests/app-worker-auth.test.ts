import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveAppWorker } from '../app-worker-auth.service.js';

test('agent app credentials resolve only current enabled owners and reject ambiguous mappings', () => {
  const token = 'a'.repeat(64);
  const links = new Map([['alice', { enabled: true, workspace_id: 'a', workerToken: token }], ['bob', { enabled: true, workspace_id: 'b', workerToken: 'b'.repeat(64) }]]);
  assert.equal(resolveAppWorker(token, links), 'alice');
  assert.equal(resolveAppWorker('unknown'.repeat(8), links), null);
  links.get('alice')!.enabled = false; assert.equal(resolveAppWorker(token, links), null);
  links.get('alice')!.enabled = true; links.get('alice')!.workerToken = 'new'.repeat(24); assert.equal(resolveAppWorker(token, links), null);
  links.get('alice')!.workerToken = token; links.get('bob')!.workerToken = token; assert.equal(resolveAppWorker(token, links), null);
});
