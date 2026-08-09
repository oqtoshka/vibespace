import express from 'express';
import bcrypt from 'bcrypt';

import { createSessionKit, SESSION_COOKIE } from './session.js';

/**
 * Password identity resolver — the upstream default.
 *
 * Owns the login flow; the session half it shares with every other resolver
 * lives in `session.js`. Downstream deployments that terminate identity
 * elsewhere (SSO, mTLS) register a different resolver instead; the manager core
 * only depends on the `resolveUser` / `router` shape.
 */

export { SESSION_COOKIE };

export function createPasswordResolver({ credentials, links, jwtSecret, cookieSecure }) {
  const session = createSessionKit({ links, jwtSecret, cookieSecure });

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

    const token = session.sign(username);
    session.applySession(req, res, token);
    // `id` is the username: the manager holds no user table, and the frontend
    // only displays it. The authoritative row comes from the worker's
    // /api/auth/user once the session is established.
    res.json({ success: true, user: { id: username, username }, token });
  });

  router.post('/logout', (req, res) => {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ success: true, message: 'Logged out successfully' });
  });

  return {
    resolveUser: session.resolveUser,
    resolveSessionCookie: session.resolveSessionCookie,
    applySession: session.applySession,
    sign: session.sign,
    router,
  };
}
