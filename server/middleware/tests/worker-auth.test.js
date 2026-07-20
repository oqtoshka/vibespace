import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, before, describe } from 'node:test';

/**
 * Worker-mode identity handling.
 *
 * The mode is read at import time, so the environment has to be set before the
 * middleware is loaded — hence the dynamic import below rather than a static
 * one. That also means this file exercises worker mode only; the JWT path is
 * covered by the local-mode suites.
 */

let tempDirectory;
let authenticateToken;
let readWorkerIdentity;
let userDb;
let closeConnection;

before(async () => {
  tempDirectory = await mkdtemp(path.join(tmpdir(), 'worker-auth-'));
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  process.env.VIBESPACE_MODE = 'worker';
  delete process.env.VS_WORKER_TOKEN;

  const connection = await import('@/modules/database/connection.js');
  closeConnection = connection.closeConnection;
  const { initializeDatabase } = await import('@/modules/database/init-db.js');
  await initializeDatabase();

  ({ userDb } = await import('@/modules/database/index.js'));
  ({ authenticateToken, readWorkerIdentity } = await import('../auth.js'));
});

after(async () => {
  closeConnection?.();
  await rm(tempDirectory, { recursive: true, force: true });
});

/** Captures what the middleware did instead of calling through to a route. */
function runMiddleware(headers) {
  const req = { headers, query: {} };
  const result = { status: null, body: null, nexted: false };
  const res = {
    status(code) {
      result.status = code;
      return res;
    },
    json(payload) {
      result.body = payload;
      return res;
    },
    setHeader() {},
  };

  return authenticateToken(req, res, () => {
    result.nexted = true;
  }).then(() => ({ ...result, user: req.user }));
}

describe('worker mode identity', () => {
  test('provisions the user named by the manager on first contact', async () => {
    const result = await runMiddleware({ 'x-vibespace-user': 'main' });

    assert.equal(result.nexted, true);
    assert.equal(result.user.username, 'main');
    assert.ok(result.user.id);
  });

  test('stores a placeholder hash no password can match', async () => {
    await runMiddleware({ 'x-vibespace-user': 'placeholder-check' });
    const row = userDb.getUserByUsername('placeholder-check');

    assert.equal(row.password_hash, 'managed:no-password');
  });

  test('exposes the same public columns as the token path, without the hash', async () => {
    const result = await runMiddleware({ 'x-vibespace-user': 'shape-check' });

    assert.deepEqual(Object.keys(result.user).sort(), ['created_at', 'id', 'last_login', 'username']);
  });

  test('reuses the row on subsequent requests', async () => {
    const first = await runMiddleware({ 'x-vibespace-user': 'repeat' });
    const second = await runMiddleware({ 'x-vibespace-user': 'repeat' });

    assert.equal(first.user.id, second.user.id);
  });

  test('keeps tenants on separate rows', async () => {
    const main = await runMiddleware({ 'x-vibespace-user': 'tenant-a' });
    const other = await runMiddleware({ 'x-vibespace-user': 'tenant-b' });

    assert.notEqual(main.user.id, other.user.id);
  });

  test('rejects a request with no identity header', async () => {
    const result = await runMiddleware({});

    assert.equal(result.status, 401);
    assert.equal(result.nexted, false);
  });

  test('rejects a username that is not a plain identifier', async () => {
    for (const username of ['../escape', 'has space', '-leading', '']) {
      const result = await runMiddleware({ 'x-vibespace-user': username });
      assert.equal(result.status, 401, `expected "${username}" to be rejected`);
    }
  });

  test('ignores an Authorization header, which cannot be verified here', async () => {
    const result = await runMiddleware({ authorization: 'Bearer whatever' });

    assert.equal(result.status, 401);
  });
});

describe('worker token enforcement', () => {
  after(() => {
    delete process.env.VS_WORKER_TOKEN;
  });

  test('accepts the manager token and rejects everything else', async () => {
    process.env.VS_WORKER_TOKEN = 'the-real-token';

    const accepted = await runMiddleware({
      'x-vibespace-user': 'main',
      'x-vibespace-worker-token': 'the-real-token',
    });
    assert.equal(accepted.nexted, true);

    // A neighbour that can route to this worker still cannot claim an identity.
    const forged = await runMiddleware({
      'x-vibespace-user': 'sanyaz',
      'x-vibespace-worker-token': 'guessed',
    });
    assert.equal(forged.status, 401);

    const missing = await runMiddleware({ 'x-vibespace-user': 'sanyaz' });
    assert.equal(missing.status, 401);
  });

  test('readWorkerIdentity applies the same rules for WebSocket upgrades', () => {
    process.env.VS_WORKER_TOKEN = 'ws-token';

    assert.equal(
      readWorkerIdentity({ headers: { 'x-vibespace-user': 'main', 'x-vibespace-worker-token': 'ws-token' } })?.username,
      'main'
    );
    assert.equal(readWorkerIdentity({ headers: { 'x-vibespace-user': 'main' } }), null);
    assert.equal(readWorkerIdentity({ headers: {} }), null);
  });
});
