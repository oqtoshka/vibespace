import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { WorkerRegistry } from '../worker-registry.service.js';

test('atomic provisioning/remapping/revocation and expired/corrupt registries fail closed', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vs-registry-'));
  const file = path.join(root, 'workers.json');
  const publish = (workers: object[], expiresAt = Date.now() + 60000) => {
    writeFileSync(file + '.next', JSON.stringify({ version: 1, expiresAt, workers }));
    renameSync(file + '.next', file);
  };
  const alice = { username: 'alice', upstream: 'http://alice:7100', workerToken: 'a'.repeat(64), workspaceDir: '/workspace' };
  try {
    publish([]);
    const registry = new WorkerRegistry(file);
    assert.equal(registry.get('alice'), undefined);
    publish([alice]);
    assert.equal(registry.get('alice')?.upstream, alice.upstream);
    publish([{ ...alice, upstream: 'http://replacement:7100' }]);
    assert.equal(registry.get('alice')?.upstream, 'http://replacement:7100');
    publish([]);
    assert.equal(registry.get('alice'), undefined);
    publish([alice], Date.now() - 1);
    assert.deepEqual([...registry.keys()], []);
    publish([alice, alice]);
    assert.equal(registry.get('alice'), undefined);
    publish([alice]);
    writeFileSync(file, '{');
    assert.equal(registry.get('alice'), undefined);
    rmSync(file);
    assert.deepEqual([...registry], []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
