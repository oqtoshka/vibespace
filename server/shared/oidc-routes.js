import express from 'express';

import {
  CALLBACK_PATH,
  FLOW_COOKIE,
  FLOW_TTL_SECONDS,
  openFlowState,
  readCookie,
  sealFlowState,
} from './oidc.js';

/**
 * The two HTTP endpoints of the authorization code flow, shared by both
 * deployment shapes.
 *
 * Everything up to "this is a verified username" is identical for the manager
 * and the single-user server; only what a username *maps to* differs. That step
 * is the `authenticate` callback, which returns the session token its own mode
 * signs — the manager's session JWT, or the local server's user JWT.
 */

/** Where the SPA lands with the freshly minted session. */
export const SPA_CALLBACK_PATH = '/auth/callback';

/**
 * The app's mount point, for deployments served under a sub-path.
 * `/ai/api/auth/oidc/callback` → `/ai`.
 */
function appBasePath(req) {
  const [pathname] = (req.originalUrl || '').split('?');
  const marker = pathname.indexOf(CALLBACK_PATH);
  return marker > 0 ? pathname.slice(0, marker) : '';
}

function cookieOptions(req, cookieSecure, maxAgeSeconds) {
  return {
    httpOnly: true,
    // Lax, not Strict: the provider redirects back with a top-level GET, and a
    // Strict cookie is withheld on exactly that navigation — the flow state
    // would be missing on every callback.
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSeconds * 1000,
    secure:
      cookieSecure === 'true'
        ? true
        : cookieSecure === 'false'
          ? false
          : String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https',
  };
}

/**
 * The SPA reads the session out of the URL fragment.
 *
 * A fragment is never sent to a server, so the token stays out of proxy logs,
 * the Referer header and the browser's history entry for any later request —
 * unlike a query parameter, which lands in all three.
 */
function spaRedirect(req, params) {
  const fragment = new URLSearchParams(params).toString();
  return `${appBasePath(req)}${SPA_CALLBACK_PATH}#${fragment}`;
}

/** A relative in-app path, or `/` — never an attacker-supplied absolute URL. */
function safeReturnTo(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) {
    return '/';
  }
  return value;
}

export function createOidcRouter({ client, flowSecret, cookieSecure = 'auto', authenticate, logPrefix = 'oidc' }) {
  const router = express.Router();

  router.get('/oidc/login', async (req, res) => {
    try {
      const redirectUri = client.resolveRedirectUri(req);
      const { url, flow } = await client.buildAuthorizationRequest({
        redirectUri,
        returnTo: safeReturnTo(req.query.returnTo),
      });

      res.cookie(FLOW_COOKIE, sealFlowState(flow, flowSecret), cookieOptions(req, cookieSecure, FLOW_TTL_SECONDS));
      res.redirect(url);
    } catch (error) {
      console.error(`[${logPrefix}] login failed: ${error.message}`);
      res.redirect(spaRedirect(req, { error: error.code || 'login_failed', message: error.message }));
    }
  });

  router.get('/oidc/callback', async (req, res) => {
    const fail = (code, message) => {
      console.error(`[${logPrefix}] callback rejected (${code}): ${message}`);
      res.clearCookie(FLOW_COOKIE, { path: '/' });
      res.redirect(spaRedirect(req, { error: code, message }));
    };

    // The provider reports its own failures here — a denied consent, an
    // unregistered redirect URI — and there is no flow left to continue.
    if (req.query.error) {
      return fail(String(req.query.error), String(req.query.error_description || 'The identity provider refused the login.'));
    }

    const flow = openFlowState(readCookie(req, FLOW_COOKIE), flowSecret);
    if (!flow) {
      return fail('expired_flow', 'This sign-in took too long or was started in another browser. Try again.');
    }

    // CSRF: the state came back in the URL and must match the one sealed into
    // the cookie when *this* browser started the flow.
    if (!req.query.state || req.query.state !== flow.state) {
      return fail('state_mismatch', 'Sign-in state did not match. Try again.');
    }

    if (!req.query.code) {
      return fail('no_code', 'The identity provider returned no authorization code.');
    }

    try {
      const tokens = await client.exchangeCode({
        code: String(req.query.code),
        codeVerifier: flow.codeVerifier,
        redirectUri: flow.redirectUri,
      });

      const claims = await client.verifyIdToken(tokens.id_token, { nonce: flow.nonce });
      const username = await client.resolveUsername(claims, tokens.access_token);

      if (!client.isAllowed(username)) {
        return fail('unmapped', `"${username}" is authenticated but not allowed into this VibeSpace.`);
      }

      const outcome = await authenticate({ req, res, username, claims, tokens });
      if (outcome?.error) {
        return fail(outcome.error, outcome.message || 'Sign-in was refused.');
      }

      res.clearCookie(FLOW_COOKIE, { path: '/' });
      res.redirect(spaRedirect(req, { token: outcome.token, returnTo: safeReturnTo(flow.returnTo) }));
    } catch (error) {
      fail(error.code || 'login_failed', error.message);
    }
  });

  return router;
}
