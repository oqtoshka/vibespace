import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

/**
 * Password identity resolver — the upstream default.
 *
 * Owns the login flow and turns any credential a browser might carry into the
 * user link the manager proxies against. Downstream deployments that terminate
 * identity at the edge (mTLS, SSO) register a different resolver instead; the
 * manager core only depends on the `resolveUser` / `router` shape.
 */

export const SESSION_COOKIE = 'vibespace_manager_session';
const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) {
      return decodeURIComponent(part.slice(separator + 1).trim());
    }
  }
  return null;
}

/**
 * Credentials a request might carry, in priority order.
 *
 * Every candidate is tried rather than just the first one present: browser-use
 * MCP clients send an unrelated bearer token, and preview iframes send only a
 * cookie, so a failed verification must fall through instead of rejecting.
 */
function candidateTokens(req, url) {
  const tokens = [];

  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    tokens.push(authHeader.slice('Bearer '.length));
  }

  const queryToken = url?.searchParams?.get('token');
  if (queryToken) tokens.push(queryToken);

  const cookieToken = readCookie(req, SESSION_COOKIE);
  if (cookieToken) tokens.push(cookieToken);

  return tokens;
}

export function createPasswordResolver({ credentials, links, jwtSecret, cookieSecure }) {
  const sign = (username) =>
    jwt.sign({ sub: username, username, iss: 'vibespace-manager' }, jwtSecret, {
      expiresIn: TOKEN_TTL_SECONDS,
    });

  const cookieOptions = (req) => ({
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: TOKEN_TTL_SECONDS * 1000,
    secure:
      cookieSecure === 'true'
        ? true
        : cookieSecure === 'false'
          ? false
          : (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https',
  });

  /**
   * @returns {{userId: string, link: object, refreshedToken?: string}
   *   | {error: 'unauthenticated'|'unmapped'|'disabled'}}
   */
  function resolveUser(req, url) {
    for (const token of candidateTokens(req, url)) {
      let decoded;
      try {
        decoded = jwt.verify(token, jwtSecret);
      } catch {
        continue; // Not ours (or expired) — try the next credential.
      }

      const username = decoded.username || decoded.sub;
      const link = links.get(username);
      if (!link) return { error: 'unmapped' };
      if (!link.enabled) return { error: 'disabled' };

      // Past half-life, hand back a fresh token so long-lived tabs don't get
      // logged out mid-session. Mirrors the single-user server's behaviour.
      let refreshedToken;
      if (decoded.exp && decoded.iat) {
        const now = Math.floor(Date.now() / 1000);
        if (now > decoded.iat + (decoded.exp - decoded.iat) / 2) {
          refreshedToken = sign(username);
        }
      }

      return { userId: username, link, refreshedToken };
    }

    return { error: 'unauthenticated' };
  }

  /** Session identity only — used to route requests the worker serves publicly. */
  function resolveSessionCookie(req) {
    const token = readCookie(req, SESSION_COOKIE);
    if (!token) return null;

    try {
      const decoded = jwt.verify(token, jwtSecret);
      const username = decoded.username || decoded.sub;
      const link = links.get(username);
      if (!link || !link.enabled) return null;
      return { userId: username, link };
    } catch {
      return null;
    }
  }

  const router = express.Router();
  router.use(express.json({ limit: '1mb' }));

  router.get('/status', (req, res) => {
    // Registration is never available in a managed deployment.
    res.json({ needsSetup: false, isAuthenticated: false });
  });

  router.post('/login', async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const passwordHash = credentials.get(username);
    const link = links.get(username);

    // Compare against a dummy hash for unknown users so a missing account and a
    // wrong password cost the same time.
    const valid = await bcrypt.compare(
      password,
      passwordHash || '$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv'
    );

    if (!passwordHash || !valid) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    if (!link.enabled) {
      return res.status(403).json({ error: 'This account is disabled' });
    }

    const token = sign(username);
    res.cookie(SESSION_COOKIE, token, cookieOptions(req));
    // `id` is the username: the manager holds no user table, and the frontend
    // only displays it. The authoritative row comes from the worker's
    // /api/auth/user once the session is established.
    res.json({ success: true, user: { id: username, username }, token });
  });

  router.post('/logout', (req, res) => {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ success: true, message: 'Logged out successfully' });
  });

  /** Re-issues the session cookie alongside a refreshed token. */
  function applySession(req, res, token) {
    res.cookie(SESSION_COOKIE, token, cookieOptions(req));
  }

  return { resolveUser, resolveSessionCookie, applySession, router, sign };
}
