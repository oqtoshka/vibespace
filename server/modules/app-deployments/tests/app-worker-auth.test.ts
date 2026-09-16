import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';

import { resolveAppWorker } from '../app-worker-auth.service.js';

test('agent app credentials resolve only current enabled owners and reject ambiguous mappings', () => {
  const workerToken = 'a'.repeat(64);
  const token = crypto.createHmac('sha256', workerToken).update('vibespace-app-control-v1').digest('hex');
  const links = new Map([['alice', { enabled: true, workspace_id: 'a', workerToken }], ['bob', { enabled: true, workspace_id: 'b', workerToken: 'b'.repeat(64) }]]);
  assert.equal(resolveAppWorker(token, links), 'alice');
  assert.equal(resolveAppWorker(workerToken, links), null); // The server credential is never an agent credential.
  assert.equal(resolveAppWorker('unknown'.repeat(8), links), null);
  links.get('alice')!.enabled = false; assert.equal(resolveAppWorker(token, links), null);
  links.get('alice')!.enabled = true; links.get('alice')!.workerToken = 'new'.repeat(24); assert.equal(resolveAppWorker(token, links), null);
  links.get('alice')!.workerToken = workerToken; links.get('bob')!.workerToken = workerToken; assert.equal(resolveAppWorker(token, links), null);
});
