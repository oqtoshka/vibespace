import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import express from 'express';
import jwt from 'jsonwebtoken';

import { cookieHeader, fragmentOf, makeCode, startFakeProvider } from '../../shared/tests/oidc-test-provider.js';

/**
 * OIDC sign-in on the single-user server.
 *
 * The provider has to exist before the routes are imported: the configuration
 * is read at import time, so the issuer URL — which only exists once the fake
 * provider has a port — must be in the environment first. Hence the dynamic
 * imports below.
 */

const JWT_SECRET = 'test-local-secret';

let tempDirectory;
let provider;
let server;
let baseUrl;
let userDb;
let closeConnection;

before(async () => {
  provider = await startFakeProvider({ clientId: 'vibespace-local' });

  tempDirectory = await mkdtemp(path.join(tmpdir(), 'local-oidc-'));
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  process.env.VIBESPACE_MODE = 'local';
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.VS_OIDC_ISSUER = provider.issuer;
  process.env.VS_OIDC_CLIENT_ID = provider.clientId;
  process.env.VS_OIDC_ALLOWED_USERS = 'main, second';
  process.env.VS_OIDC_LABEL = 'Authentik';
  process.env.VS_OIDC_COOKIE_SECURE = 'false';

  const connection = await import('@/modules/database/connection.js');
  closeConnection = connection.closeConnection;
  const { initializeDatabase } = await import('@/modules/database/init-db.js');
  await initializeDatabase();
  ({ userDb } = await import('@/modules/database/index.js'));

  // A fresh DATABASE_PATH is seeded from any legacy database/auth.db in the
  // checkout, so "no users yet" is only true by accident of whose machine this
  // runs on. Start from empty deliberately.
  connection.getConnection().prepare('DELETE FROM users').run();

  const { default: authRoutes } = await import('../auth.js');
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  await provider.close();
  closeConnection?.();
  await rm(tempDirectory, { recursive: true, force: true });
  for (const key of [
    'VS_OIDC_ISSUER',
    'VS_OIDC_CLIENT_ID',
    'VS_OIDC_ALLOWED_USERS',
    'VS_OIDC_LABEL',
    'VS_OIDC_COOKIE_SECURE',
  ]) {
    delete process.env[key];
  }
});

async function signIn(username) {
  const start = await fetch(`${baseUrl}/api/auth/oidc/login`, { redirect: 'manual' });
  const authorize = new URL(start.headers.get('location'));

  const params = new URLSearchParams({
    state: authorize.searchParams.get('state'),
    code: makeCode({ username, nonce: authorize.searchParams.get('nonce') }),
  });

  const res = await fetch(`${baseUrl}/api/auth/oidc/callback?${params}`, {
    redirect: 'manual',
    headers: { cookie: cookieHeader(start) },
  });

  return fragmentOf(res.headers.get('location') || '');
}

describe('local oidc: password auth is closed', () => {
  it('advertises SSO instead of a setup screen', async () => {
    const res = await fetch(`${baseUrl}/api/auth/status`);

    assert.deepEqual(await res.json(), {
      needsSetup: false,
      isAuthenticated: false,
      authMode: 'oidc',
      loginUrl: '/api/auth/oidc/login',
      providerLabel: 'Authentik',
    });
  });

  it('refuses a password login', async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'main', password: 'hunter2' }),
    });

    // Leaving this open would be a way around SSO, not a fallback for it.
    assert.equal(res.status, 403);
  });

  it('refuses registration', async () => {
    const res = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'main', password: 'hunter2' }),
    });

    assert.equal(res.status, 403);
  });
});

describe('local oidc: binding an identity to the single user', () => {
  it('provisions the user on first sign-in and issues the usual JWT', async () => {
    assert.equal(userDb.hasUsers(), false);

    const fragment = await signIn('main');
    const token = fragment.get('token');
    assert.match(token ?? '', /^ey/);

    // The same token shape `authenticateToken` already verifies — sessions,
    // WebSocket auth and refresh keep working untouched.
    const claims = jwt.verify(token, JWT_SECRET);
    assert.equal(claims.username, 'main');

    const created = userDb.getUserByUsername('main');
    assert.ok(created);
    assert.equal(claims.userId, created.id);
  });

  it('signs the same user in again without creating a second row', async () => {
    const fragment = await signIn('main');

    assert.match(fragment.get('token') ?? '', /^ey/);
    assert.equal(jwt.verify(fragment.get('token'), JWT_SECRET).username, 'main');
  });

  it('refuses a second identity — this install belongs to one user', async () => {
    const fragment = await signIn('second');

    assert.equal(fragment.get('error'), 'unmapped');
    assert.equal(userDb.getUserByUsername('second'), undefined);
  });

  it('refuses an identity that is not on the allow-list', async () => {
    const fragment = await signIn('stranger');

    // The provider serves more than this app; authenticated is not authorized.
    assert.equal(fragment.get('error'), 'unmapped');
    assert.match(fragment.get('message') ?? '', /stranger/);
  });
});

describe('session refresh', () => {
  it('re-issues a token for the bearer', async () => {
    const token = (await signIn('main')).get('token');

    const res = await fetch(`${baseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });

    // The client calls this on a timer once the token passes its half-life;
    // a 404 here silently ends every long-lived session at the 7-day mark.
    assert.equal(res.status, 200);

    const { token: refreshed } = await res.json();
    assert.match(refreshed ?? '', /^ey/);
    assert.equal(jwt.verify(refreshed, JWT_SECRET).username, 'main');
  });

  it('rejects an unauthenticated refresh', async () => {
    const res = await fetch(`${baseUrl}/api/auth/refresh`, { method: 'POST' });

    assert.equal(res.status, 401);
  });
});
