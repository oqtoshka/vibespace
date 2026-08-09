import crypto from 'node:crypto';
import http from 'node:http';

import express from 'express';
import jwt from 'jsonwebtoken';

/**
 * A stand-in identity provider for the OIDC suites.
 *
 * Real enough to exercise the parts that matter — discovery, a JWKS the client
 * has to fetch and match by `kid`, an RS256 id_token it has to verify — without
 * a network dependency or a live Authentik.
 *
 * The authorization endpoint is never actually visited: a browser redirect is
 * not something a test can follow into someone else's login page. Instead the
 * test reads the redirect it *would* have followed, then hands the callback a
 * code minted by `makeCode`, which carries what the token endpoint should say.
 */

const KEY_ID = 'test-key-1';

export function makeCode(instructions) {
  return Buffer.from(JSON.stringify(instructions)).toString('base64url');
}

export async function startFakeProvider({ clientId = 'vibespace' } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KEY_ID, use: 'sig', alg: 'RS256' };

  const app = express();
  app.use(express.urlencoded({ extended: false }));

  /** Everything the token endpoint was asked, for assertions. */
  const tokenRequests = [];

  let issuer;

  app.get('/.well-known/openid-configuration', (req, res) => {
    res.json({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
      userinfo_endpoint: `${issuer}/userinfo`,
      end_session_endpoint: `${issuer}/end-session`,
    });
  });

  app.get('/jwks', (req, res) => {
    res.json({ keys: [jwk] });
  });

  app.post('/token', (req, res) => {
    tokenRequests.push(req.body);

    let instructions;
    try {
      instructions = JSON.parse(Buffer.from(String(req.body.code), 'base64url').toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'invalid_grant' });
    }

    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: instructions.issuer ?? issuer,
      aud: instructions.audience ?? clientId,
      sub: instructions.sub ?? 'subject-1',
      nonce: instructions.nonce,
      iat: now,
      exp: now + 300,
    };

    // Omitted deliberately when the test wants the userinfo fallback exercised.
    if (instructions.username !== null) {
      claims.preferred_username = instructions.username ?? 'main';
    }

    res.json({
      access_token: 'access-token',
      token_type: 'Bearer',
      id_token: jwt.sign(claims, privateKey, { algorithm: 'RS256', keyid: KEY_ID }),
    });
  });

  app.get('/userinfo', (req, res) => {
    res.json({ preferred_username: 'from-userinfo' });
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${server.address().port}`;

  return {
    issuer,
    clientId,
    tokenRequests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Set-Cookie values a response asked the browser to keep, as a `Cookie` header. */
export function cookieHeader(response) {
  return response.headers
    .getSetCookie()
    .map((entry) => entry.split(';')[0])
    .join('; ');
}

/** The `#a=b&c=d` fragment of a redirect, parsed. */
export function fragmentOf(location) {
  const marker = location.indexOf('#');
  return new URLSearchParams(marker === -1 ? '' : location.slice(marker + 1));
}
