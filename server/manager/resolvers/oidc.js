import express from 'express';

import { createOidcClient } from '../../shared/oidc.js';
import { createOidcRouter } from '../../shared/oidc-routes.js';

import { createSessionKit, SESSION_COOKIE } from './session.js';

/**
 * OpenID Connect identity resolver — sign-in against an external provider
 * (Authentik, Keycloak, Entra, …) instead of the manager's own password map.
 *
 * The provider proves *who* someone is; the user map still decides *whether*
 * they get in and which worker they land on. That split is deliberate: an
 * identity provider usually serves more than this one application, so treating
 * "authenticated" as "authorized" would hand every account in the directory a
 * VibeSpace worker.
 *
 * Once the callback succeeds the session is the ordinary manager JWT — same
 * cookie, same refresh, same proxy path as password auth.
 */

const LOGIN_URL = '/api/auth/oidc/login';

export function createOidcResolver({ links, jwtSecret, cookieSecure, oidc }) {
  if (!oidc) {
    throw new Error(
      'VS_MANAGER_AUTH=oidc requires VS_OIDC_ISSUER and VS_OIDC_CLIENT_ID to be set.'
    );
  }

  const client = createOidcClient(oidc);
  const session = createSessionKit({ links, jwtSecret, cookieSecure });

  const router = express.Router();
  router.use(express.json({ limit: '1mb' }));

  router.get('/status', (req, res) => {
    res.json({
      needsSetup: false,
      isAuthenticated: false,
      authMode: 'oidc',
      loginUrl: LOGIN_URL,
      providerLabel: oidc.label,
    });
  });

  // Password login stays mounted and stays shut. Leaving it to 404 would look
  // like a broken deployment; answering plainly says the door moved.
  router.post('/login', (req, res) => {
    res.status(403).json({ error: `Password login is disabled — sign in with ${oidc.label}.` });
  });

  router.post('/register', (req, res) => {
    res.status(403).json({ error: 'Accounts are managed by the identity provider.' });
  });

  router.post('/logout', async (req, res) => {
    res.clearCookie(SESSION_COOKIE, { path: '/' });

    // Without this the provider's own session survives, and "log out" is undone
    // by the next silent re-authentication. Opt-in, because on a shared device
    // it also signs the user out of every other application.
    const redirectTo = await client
      .endSessionUrl({ postLogoutRedirectUri: null })
      .catch(() => null);

    res.json({ success: true, message: 'Logged out successfully', ...(redirectTo ? { redirectTo } : {}) });
  });

  router.use(
    createOidcRouter({
      client,
      flowSecret: jwtSecret,
      cookieSecure,
      logPrefix: 'manager/oidc',
      authenticate: ({ req, res, username }) => {
        const link = links.get(username);
        if (!link) {
          return {
            error: 'unmapped',
            message: `"${username}" signed in successfully but has no VibeSpace worker.`,
          };
        }
        if (!link.enabled) {
          return { error: 'disabled', message: 'This account is disabled.' };
        }

        const token = session.sign(username);
        session.applySession(req, res, token);
        return { token };
      },
    })
  );

  return {
    resolveUser: session.resolveUser,
    resolveSessionCookie: session.resolveSessionCookie,
    applySession: session.applySession,
    sign: session.sign,
    router,
  };
}
