import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { isManagedUsername } from '@/shared/index.js';
import { loadManagerConfig, WorkerRegistry } from '../index.js';

test('managed identities preserve dots, dashes and case while rejecting unsafe keys', () => {
  for (const value of ['person.name', 'person-name', 'Person.Name', 'a', 'a'.repeat(64)]) {
    assert.equal(isManagedUsername(value), true, value);
  }
  for (const value of ['', '.', '..', '../person', 'a/b', 'a\\b', 'a b', 'a\n', '.person', 'a'.repeat(65), null, 123]) {
    assert.equal(isManagedUsername(value), false, String(value));
  }
});

test('static and atomic registries distinguish dotted identities from dashed identities', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vs-dots-'));
  const filename = path.join(root, 'workers.json');
  const dotted = { username: 'person.name', upstream: 'http://dotted:7100', workerToken: 'd'.repeat(64), workspaceDir: '/workspace' };
  const dashed = { ...dotted, username: 'person-name', upstream: 'http://dashed:7100' };
  const publish = (workers: object[]) => {
    writeFileSync(filename + '.next', JSON.stringify({ version: 1, expiresAt: Date.now() + 60000, workers }));
    renameSync(filename + '.next', filename);
  };
  try {
    publish([dashed]);
    const registry = new WorkerRegistry(filename);
    assert.equal(registry.get(dotted.username), undefined);
    publish([dotted, dashed]);
    assert.equal(registry.get(dotted.username)?.upstream, dotted.upstream);
    assert.equal(registry.get(dashed.username)?.upstream, dashed.upstream);
    publish([dashed]);
    assert.equal(registry.get(dotted.username), undefined);
    const config = loadManagerConfig({ VS_MANAGER_AUTH: 'oidc', VS_MANAGER_JWT_SECRET: 'test',
      VS_MANAGER_USERS: JSON.stringify({ [dotted.username]: dotted, [dashed.username]: dashed }) }, null);
    assert.equal(config.links.get(dotted.username)?.upstream, dotted.upstream);
    assert.equal(config.links.get(dashed.username)?.upstream, dashed.upstream);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
