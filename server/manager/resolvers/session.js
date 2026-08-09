import jwt from 'jsonwebtoken';

import { readCookie } from '../../shared/oidc.js';

/**
 * The manager's session mechanics, independent of how identity was proven.
 *
 * Password and SSO differ only in the login step; once a user is identified,
 * both carry the same manager-signed JWT in the same cookie and are resolved
 * the same way on every proxied request. Keeping that half here means adding a
 * resolver is writing a login flow, not re-deriving session handling.
 */

export const SESSION_COOKIE = 'vibespace_manager_session';
export const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

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

export function createSessionKit({ links, jwtSecret, cookieSecure }) {
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

  /** Re-issues the session cookie alongside a refreshed token. */
  function applySession(req, res, token) {
    res.cookie(SESSION_COOKIE, token, cookieOptions(req));
  }

  return { sign, cookieOptions, resolveUser, resolveSessionCookie, applySession };
}
