import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import http from 'node:http';

import bcrypt from 'bcrypt';
import express from 'express';
import jwt from 'jsonwebtoken';

import { createPasswordResolver, SESSION_COOKIE } from '../resolvers/password.js';

const JWT_SECRET = 'test-manager-secret';
const PASSWORD = 'correct-horse';

function buildResolver({ enabled = true } = {}) {
  const passwordHash = bcrypt.hashSync(PASSWORD, 4); // low cost keeps the suite fast
  return createPasswordResolver({
    credentials: new Map([['main', passwordHash]]),
    links: new Map([['main', { user_id: 'main', upstream: 'http://127.0.0.1:7100', enabled }]]),
    jwtSecret: JWT_SECRET,
    cookieSecure: 'false',
  });
}

/** Minimal request stand-in — the resolver only reads headers. */
const asRequest = (headers = {}) => ({ headers });
const withUrl = (search = '') => new URL(`http://manager.local/api/projects${search}`);

describe('password resolver: login flow', () => {
  let server;
  let baseUrl;

  before(async () => {
    const app = express();
    app.use('/api/auth', buildResolver().router);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => server.close());

  it('reports that no setup is needed', async () => {
    const res = await fetch(`${baseUrl}/api/auth/status`);
    assert.deepEqual(await res.json(), { needsSetup: false, isAuthenticated: false });
  });

  it('issues a token and a session cookie on valid credentials', async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'main', password: PASSWORD }),
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.user.username, 'main');
    assert.match(body.token, /^ey/);
    assert.match(res.headers.get('set-cookie') ?? '', new RegExp(`${SESSION_COOKIE}=`));
  });

  it('rejects a wrong password', async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'main', password: 'wrong' }),
    });

    assert.equal(res.status, 401);
  });

  it('rejects an unknown user with the same response as a wrong password', async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'nobody', password: PASSWORD }),
    });

    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'Invalid username or password' });
  });

  it('requires both fields', async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'main' }),
    });

    assert.equal(res.status, 400);
  });
});

describe('password resolver: credential precedence', () => {
  const resolver = buildResolver();
  const validToken = resolver.sign('main');

  it('accepts a bearer token', () => {
    const result = resolver.resolveUser(asRequest({ authorization: `Bearer ${validToken}` }), withUrl());

    assert.equal(result.userId, 'main');
    assert.equal(result.link.upstream, 'http://127.0.0.1:7100');
  });

  it('accepts a query token, for clients that cannot set headers', () => {
    const result = resolver.resolveUser(asRequest(), withUrl(`?token=${validToken}`));

    assert.equal(result.userId, 'main');
  });

  it('accepts a session cookie', () => {
    const result = resolver.resolveUser(asRequest({ cookie: `${SESSION_COOKIE}=${validToken}` }), withUrl());

    assert.equal(result.userId, 'main');
  });

  it('falls through an unrelated bearer token to a valid cookie', () => {
    // Browser-use MCP clients send their own bearer scheme; a failed verify
    // must not shadow the session cookie that actually identifies the user.
    const result = resolver.resolveUser(
      asRequest({ authorization: 'Bearer not-a-manager-jwt', cookie: `${SESSION_COOKIE}=${validToken}` }),
      withUrl()
    );

    assert.equal(result.userId, 'main');
  });

  it('reports unauthenticated when nothing is presented', () => {
    assert.deepEqual(resolver.resolveUser(asRequest(), withUrl()), { error: 'unauthenticated' });
  });

  it('rejects a token signed with another key', () => {
    const forged = jwt.sign({ username: 'main' }, 'other-secret', { expiresIn: '1h' });
    const result = resolver.resolveUser(asRequest({ authorization: `Bearer ${forged}` }), withUrl());

    assert.deepEqual(result, { error: 'unauthenticated' });
  });

  it('reports unmapped for a valid token naming a user that no longer exists', () => {
    const orphan = jwt.sign({ username: 'ghost', sub: 'ghost' }, JWT_SECRET, { expiresIn: '1h' });
    const result = resolver.resolveUser(asRequest({ authorization: `Bearer ${orphan}` }), withUrl());

    assert.deepEqual(result, { error: 'unmapped' });
  });

  it('reports disabled for a deactivated account', () => {
    const disabled = buildResolver({ enabled: false });
    const token = disabled.sign('main');
    const result = disabled.resolveUser(asRequest({ authorization: `Bearer ${token}` }), withUrl());

    assert.deepEqual(result, { error: 'disabled' });
  });
});

describe('password resolver: refresh and cookie-only routing', () => {
  const resolver = buildResolver();

  it('refreshes a token past its half-life', () => {
    const now = Math.floor(Date.now() / 1000);
    const stale = jwt.sign({ username: 'main', sub: 'main', iat: now - 5000, exp: now + 1000 }, JWT_SECRET);
    const result = resolver.resolveUser(asRequest({ authorization: `Bearer ${stale}` }), withUrl());

    assert.equal(result.userId, 'main');
    assert.match(result.refreshedToken ?? '', /^ey/);
  });

  it('leaves a fresh token alone', () => {
    const result = resolver.resolveUser(asRequest({ authorization: `Bearer ${resolver.sign('main')}` }), withUrl());

    assert.equal(result.refreshedToken, undefined);
  });

  it('resolves public paths from the cookie only', () => {
    const token = resolver.sign('main');

    assert.equal(resolver.resolveSessionCookie(asRequest({ cookie: `${SESSION_COOKIE}=${token}` }))?.userId, 'main');
    // A bearer token must not stand in for the cookie here.
    assert.equal(resolver.resolveSessionCookie(asRequest({ authorization: `Bearer ${token}` })), null);
    assert.equal(resolver.resolveSessionCookie(asRequest()), null);
  });

  it('ignores other cookies on the way to the session cookie', () => {
    const token = resolver.sign('main');
    const req = asRequest({ cookie: `theme=dark; ${SESSION_COOKIE}=${token}; other=1` });

    assert.equal(resolver.resolveSessionCookie(req)?.userId, 'main');
  });
});
