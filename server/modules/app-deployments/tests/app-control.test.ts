import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import Database from 'better-sqlite3';

import { AppControl } from '../app-control.service.js';

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'app-control-'));
  const links = new Map([['alice', { enabled: true, workspace_id: 'wa' }], ['bob', { enabled: true, workspace_id: 'wb' }]]);
  const file = path.join(root, 'apps.db'); const key = 'test-only-signing-key-'.repeat(3);
  const control = new AppControl(file, links, 'apps.example.com', key);
  const db = new Database(file);
  const input = { name: 'Campaign', source: 'projects/campaign', runtime: 'python', entrypoint: 'server.py' };
  const ready = (id: string) => db.prepare("UPDATE applications SET observed_generation=generation,status='running' WHERE id=?").run(id);
  return { control, links, db, key, input, ready, close: () => { control.close(); db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('apps isolate owners and workspace generations, refuse traversal and unknown runtimes', () => {
  const f = fixture();
  try {
    for (const source of ['../secret', '/absolute', 'projects/../secret', 'projects/.config', 'a\\b', 'a//b']) {
      assert.throws(() => f.control.create('alice', { ...f.input, source }));
    }
    assert.throws(() => f.control.create('alice', { ...f.input, runtime: 'docker' }));
    const app = f.control.create('alice', f.input);
    assert.equal(f.control.list('bob').apps.length, 0);
    assert.throws(() => f.control.logs('bob', app.id), /not found/);
    assert.throws(() => f.control.command('bob', app.id, 'remove'), /not found/);
    f.links.set('alice', { enabled: true, workspace_id: 'replacement' });
    assert.equal(f.control.list('alice').apps.length, 0);
    assert.throws(() => f.control.grant('alice', app.id, true), /not found/);
  } finally { f.close(); }
});

test('commands serialize pending generations and retain capacity after removal', () => {
  const f = fixture();
  try {
    const app = f.control.create('alice', f.input);
    assert.throws(() => f.control.command('alice', app.id, 'stop'), /pending/);
    f.ready(app.id);
    const stopped = f.control.command('alice', app.id, 'stop');
    assert.equal(stopped.desired, 'stopped'); assert.equal(stopped.generation, 2);
    f.ready(app.id);
    const removed = f.control.command('alice', app.id, 'remove');
    assert.equal(removed.desired, 'removed'); assert.equal(removed.access_version, 2);
    f.control.create('alice', f.input); f.control.create('alice', f.input);
    assert.throws(() => f.control.create('alice', f.input), /capacity/);
    assert.equal(f.control.list('alice').apps.length, 3);
  } finally { f.close(); }
});

test('access grants are signed, app-scoped, expire and become stale after revocation', () => {
  const f = fixture();
  try {
    const app = f.control.create('alice', f.input);
    assert.throws(() => f.control.grant('alice', app.id, false), /not running/);
    f.ready(app.id);
    const grant = new URL(f.control.grant('alice', app.id, true).url).searchParams.get('grant')!;
    const [payload, signature] = grant.split('.');
    assert.equal(signature, crypto.createHmac('sha256', f.key).update(payload).digest('base64url'));
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString());
    assert.equal(decoded.app, app.id); assert.equal(decoded.kind, 'share');
    assert.ok(decoded.exp > Date.now() / 1000 && decoded.exp < Date.now() / 1000 + 7 * 86400 + 1);
    f.control.revoke('alice', app.id);
    const next = new URL(f.control.grant('alice', app.id, false).url).searchParams.get('grant')!.split('.')[0];
    assert.equal(JSON.parse(Buffer.from(next, 'base64url').toString()).version, decoded.version + 1);
  } finally { f.close(); }
});
