import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';

import express from 'express';

import { createOidcResolver } from '../resolvers/oidc.js';
import { SESSION_COOKIE } from '../resolvers/session.js';
import { cookieHeader, fragmentOf, makeCode, startFakeProvider } from '../../shared/tests/oidc-test-provider.js';

const JWT_SECRET = 'test-manager-secret';

let provider;
let server;
let baseUrl;
let resolver;

const links = new Map([
  ['main', { user_id: 'main', upstream: 'http://127.0.0.1:7100', enabled: true }],
  ['retired', { user_id: 'retired', upstream: 'http://127.0.0.1:7101', enabled: false }],
]);

before(async () => {
  provider = await startFakeProvider();

  resolver = createOidcResolver({
    links,
    jwtSecret: JWT_SECRET,
    cookieSecure: 'false',
    oidc: {
      issuer: provider.issuer,
      clientId: provider.clientId,
      clientSecret: 'shhh',
      redirectUri: null,
      scopes: 'openid profile email',
      usernameClaim: 'preferred_username',
      label: 'Authentik',
      allowedUsers: null,
      cookieSecure: 'false',
      endSessionOnLogout: false,
    },
  });

  const app = express();
  app.use('/api/auth', resolver.router);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await provider.close();
});

/** Starts a login and returns the authorize URL plus the flow cookie. */
async function beginLogin(returnTo) {
  const query = returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : '';
  const res = await fetch(`${baseUrl}/api/auth/oidc/login${query}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  return { authorize: new URL(res.headers.get('location')), cookie: cookieHeader(res) };
}

/** Drives the callback with a code of the test's choosing. */
async function callback({ cookie, code, state }) {
  const params = new URLSearchParams();
  if (code) params.set('code', code);
  if (state) params.set('state', state);

  const res = await fetch(`${baseUrl}/api/auth/oidc/callback?${params}`, {
    redirect: 'manual',
    headers: cookie ? { cookie } : {},
  });
  return { res, fragment: fragmentOf(res.headers.get('location') || '') };
}

describe('manager oidc resolver: advertising the flow', () => {
  it('tells the frontend to use SSO', async () => {
    const res = await fetch(`${baseUrl}/api/auth/status`);

    assert.deepEqual(await res.json(), {
      needsSetup: false,
      isAuthenticated: false,
      authMode: 'oidc',
      loginUrl: '/api/auth/oidc/login',
      providerLabel: 'Authentik',
    });
  });

  it('keeps password login shut rather than 404', async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'main', password: 'anything' }),
    });

    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /Authentik/);
  });
});

describe('manager oidc resolver: the authorization request', () => {
  it('redirects to the provider with PKCE and a nonce', async () => {
    const { authorize, cookie } = await beginLogin();

    assert.equal(authorize.origin, provider.issuer);
    assert.equal(authorize.pathname, '/authorize');
    assert.equal(authorize.searchParams.get('response_type'), 'code');
    assert.equal(authorize.searchParams.get('client_id'), provider.clientId);
    assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(authorize.searchParams.get('code_challenge'));
    assert.ok(authorize.searchParams.get('state'));
    assert.ok(authorize.searchParams.get('nonce'));
    // The flow state must travel with the browser: the manager keeps no
    // server-side store, so a restart mid-login has to remain survivable.
    assert.match(cookie, /vibespace_oidc_flow=/);
  });

  it('derives the redirect URI from the request when none is configured', async () => {
    const { authorize } = await beginLogin();

    assert.equal(authorize.searchParams.get('redirect_uri'), `${baseUrl}/api/auth/oidc/callback`);
  });
});

describe('manager oidc resolver: completing a login', () => {
  it('issues a session the proxy path accepts', async () => {
    const { authorize, cookie } = await beginLogin('/session/abc');
    const { res, fragment } = await callback({
      cookie,
      state: authorize.searchParams.get('state'),
      code: makeCode({ username: 'main', nonce: authorize.searchParams.get('nonce') }),
    });

    assert.equal(res.status, 302);
    assert.equal(fragment.get('returnTo'), '/session/abc');

    const token = fragment.get('token');
    assert.match(token, /^ey/);

    // The point of the whole flow: this token routes to a worker.
    const identity = resolver.resolveUser({ headers: { authorization: `Bearer ${token}` } }, new URL('http://m/api/x'));
    assert.equal(identity.userId, 'main');
    assert.equal(identity.link.upstream, 'http://127.0.0.1:7100');

    // The cookie matters as much as the token: preview iframes and other
    // subresource requests carry nothing else.
    assert.match(cookieHeader(res), new RegExp(`${SESSION_COOKIE}=`));
  });

  it('sends the code verifier to the token endpoint', async () => {
    const before = provider.tokenRequests.length;
    const { authorize, cookie } = await beginLogin();
    await callback({
      cookie,
      state: authorize.searchParams.get('state'),
      code: makeCode({ username: 'main', nonce: authorize.searchParams.get('nonce') }),
    });

    const request = provider.tokenRequests[before];
    assert.ok(request.code_verifier, 'PKCE verifier was not sent');
    assert.equal(request.grant_type, 'authorization_code');
  });

  it('falls back to userinfo when the id_token carries no username', async () => {
    const { authorize, cookie } = await beginLogin();
    const { fragment } = await callback({
      cookie,
      state: authorize.searchParams.get('state'),
      code: makeCode({ username: null, nonce: authorize.searchParams.get('nonce') }),
    });

    // "from-userinfo" is not in the user map, which is exactly how we know the
    // fallback ran rather than the login silently failing earlier.
    assert.equal(fragment.get('error'), 'unmapped');
    assert.match(fragment.get('message'), /from-userinfo/);
  });
});

describe('manager oidc resolver: refusing a bad callback', () => {
  it('rejects a state that does not match the flow', async () => {
    const { authorize, cookie } = await beginLogin();
    const { fragment } = await callback({
      cookie,
      state: 'not-the-state',
      code: makeCode({ username: 'main', nonce: authorize.searchParams.get('nonce') }),
    });

    assert.equal(fragment.get('error'), 'state_mismatch');
  });

  it('rejects a callback with no flow cookie', async () => {
    const { authorize } = await beginLogin();
    const { fragment } = await callback({
      state: authorize.searchParams.get('state'),
      code: makeCode({ username: 'main', nonce: authorize.searchParams.get('nonce') }),
    });

    assert.equal(fragment.get('error'), 'expired_flow');
  });

  it('rejects an id_token minted for another login', async () => {
    const { authorize, cookie } = await beginLogin();
    const { fragment } = await callback({
      cookie,
      state: authorize.searchParams.get('state'),
      code: makeCode({ username: 'main', nonce: 'a-nonce-from-somewhere-else' }),
    });

    assert.equal(fragment.get('error'), 'invalid_token');
  });

  it('rejects an id_token issued to another client', async () => {
    const { authorize, cookie } = await beginLogin();
    const { fragment } = await callback({
      cookie,
      state: authorize.searchParams.get('state'),
      code: makeCode({
        username: 'main',
        nonce: authorize.searchParams.get('nonce'),
        audience: 'some-other-app',
      }),
    });

    assert.equal(fragment.get('error'), 'invalid_token');
  });

  it('authenticates a user the deployment has no worker for, then refuses them', async () => {
    const { authorize, cookie } = await beginLogin();
    const { fragment } = await callback({
      cookie,
      state: authorize.searchParams.get('state'),
      code: makeCode({ username: 'stranger', nonce: authorize.searchParams.get('nonce') }),
    });

    assert.equal(fragment.get('error'), 'unmapped');
  });

  it('refuses a disabled account', async () => {
    const { authorize, cookie } = await beginLogin();
    const { fragment } = await callback({
      cookie,
      state: authorize.searchParams.get('state'),
      code: makeCode({ username: 'retired', nonce: authorize.searchParams.get('nonce') }),
    });

    assert.equal(fragment.get('error'), 'disabled');
  });

  it('refuses a username that is not a usable identifier', async () => {
    const { authorize, cookie } = await beginLogin();
    const { fragment } = await callback({
      cookie,
      state: authorize.searchParams.get('state'),
      code: makeCode({ username: 'someone@example.com', nonce: authorize.searchParams.get('nonce') }),
    });

    // Sanitizing it into shape would route the login to a tenant nobody named.
    assert.equal(fragment.get('error'), 'invalid_username');
  });
});
