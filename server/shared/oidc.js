import crypto from 'crypto';

import jwt from 'jsonwebtoken';

/**
 * OpenID Connect client — authorization code flow with PKCE.
 *
 * Shared by both deployment shapes: the manager's `oidc` identity resolver and
 * the single-user server's OIDC routes. Neither owns the protocol, so the flow
 * lives here once and each caller only decides what a verified identity maps to.
 *
 * Written against the discovery document rather than any one vendor, but the
 * defaults are chosen for Authentik: `preferred_username` is the claim its
 * OAuth2/OpenID provider carries a login name in, and its issuer URL keeps a
 * trailing slash that must survive into `iss` validation.
 *
 * No new dependency: JWKS keys are imported with `crypto.createPublicKey` in
 * JWK format and handed to the `jsonwebtoken` this project already carries.
 */

export const DEFAULT_SCOPES = 'openid profile email';
export const DEFAULT_USERNAME_CLAIM = 'preferred_username';
export const CALLBACK_PATH = '/api/auth/oidc/callback';

// Asymmetric only. An id_token signed with HS256 is signed with the client
// secret, which turns any party holding it into an issuer.
const SUPPORTED_ALGORITHMS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512'];

const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const JWKS_TTL_MS = 10 * 60 * 1000;
const CLOCK_TOLERANCE_SECONDS = 60;
/** How long any single call to the identity provider may take. */
const PROVIDER_TIMEOUT_MS = 10_000;

/** The in-flight login's state/nonce/verifier travel in this cookie. */
export const FLOW_COOKIE = 'vibespace_oidc_flow';
export const FLOW_TTL_SECONDS = 600;

/** Usernames become filesystem-adjacent identifiers downstream, so keep them boring. */
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export class OidcError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OidcError';
    this.code = code;
  }
}

const base64url = (buffer) => buffer.toString('base64url');
const randomToken = (bytes = 32) => base64url(crypto.randomBytes(bytes));

/**
 * Reads the OIDC settings off the environment, or null when none are set.
 *
 * A single unset `VS_OIDC_ISSUER` is what keeps every existing install on
 * password auth, so the absent case is a normal return rather than an error.
 */
export function loadOidcConfig(env = process.env) {
  const issuer = (env.VS_OIDC_ISSUER || '').trim();
  if (!issuer) return null;

  const clientId = (env.VS_OIDC_CLIENT_ID || '').trim();
  if (!clientId) {
    throw new Error('VS_OIDC_ISSUER is set but VS_OIDC_CLIENT_ID is missing.');
  }

  try {
    new URL(issuer);
  } catch {
    throw new Error(`VS_OIDC_ISSUER is not a valid URL: ${issuer}`);
  }

  const allowedRaw = (env.VS_OIDC_ALLOWED_USERS || '').trim();
  const allowedUsers = allowedRaw
    ? new Set(allowedRaw.split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean))
    : null;

  return {
    issuer,
    clientId,
    clientSecret: (env.VS_OIDC_CLIENT_SECRET || '').trim() || null,
    // Optional: providers match the redirect URI exactly, and deriving it from
    // request headers is only safe behind a proxy that sets them honestly.
    redirectUri: (env.VS_OIDC_REDIRECT_URI || '').trim() || null,
    scopes: (env.VS_OIDC_SCOPES || DEFAULT_SCOPES).trim(),
    usernameClaim: (env.VS_OIDC_USERNAME_CLAIM || DEFAULT_USERNAME_CLAIM).trim(),
    label: (env.VS_OIDC_LABEL || '').trim() || 'single sign-on',
    allowedUsers,
    // `auto` follows X-Forwarded-Proto. The manager passes its own setting for
    // session cookies; this covers the single-user server, which has none.
    cookieSecure: (env.VS_OIDC_COOKIE_SECURE || 'auto').trim(),
    // End the provider's session too, so "log out" is not undone by the next
    // silent re-authentication.
    endSessionOnLogout: env.VS_OIDC_END_SESSION_ON_LOGOUT === 'true',
  };
}

/** `https://host/base` from a proxied request, for deriving the redirect URI. */
export function requestOrigin(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const proto = forwardedProto || (req.socket?.encrypted ? 'https' : 'http');
  const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const host = forwardedHost || req.headers.host || '';
  return `${proto}://${host}`;
}

/**
 * Seals the in-flight login into a short-lived signed token.
 *
 * State, nonce and PKCE verifier must survive a round trip through the identity
 * provider without a server-side store — the manager may be restarted, and a
 * worker deployment has no shared session table. Signed with the same secret
 * that signs sessions, so a forged flow cannot claim a nonce.
 */
export function sealFlowState(flow, secret) {
  return jwt.sign(flow, secret, { expiresIn: FLOW_TTL_SECONDS });
}

export function openFlowState(sealed, secret) {
  if (!sealed) return null;
  try {
    const decoded = jwt.verify(sealed, secret);
    return typeof decoded === 'object' ? decoded : null;
  } catch {
    return null;
  }
}

/** Reads one cookie off a raw request; the manager has no cookie-parser. */
export function readCookie(req, name) {
  const header = req.headers?.cookie;
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

export function createOidcClient(config, { fetchImpl = globalThis.fetch } = {}) {
  let discoveryCache = null;
  let jwksCache = null;

  const discoveryUrl = `${config.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;

  async function getJson(url, init) {
    let response;
    try {
      // A provider that accepts the connection and then never answers would
      // otherwise hold the request until Node's own five-minute ceiling, and
      // the sign-in button spins for all of it. Authentik does exactly this
      // when one of its workers is wedged: the connection is made, the reply
      // never comes. Ten seconds is far longer than a healthy token exchange
      // and short enough to fail into a message the user can act on.
      response = await fetchImpl(url, { signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS), ...init });
    } catch (error) {
      const detail = error.name === 'TimeoutError'
        ? `no answer within ${PROVIDER_TIMEOUT_MS / 1000}s`
        : error.message;
      throw new OidcError('provider_unreachable', `Could not reach ${url}: ${detail}`);
    }

    const body = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new OidcError('provider_response', `${url} did not return JSON (HTTP ${response.status}).`);
    }

    if (!response.ok) {
      const detail = parsed.error_description || parsed.error || `HTTP ${response.status}`;
      throw new OidcError('provider_response', `${url} failed: ${detail}`);
    }

    return parsed;
  }

  async function getDiscovery() {
    if (discoveryCache && discoveryCache.expiresAt > Date.now()) {
      return discoveryCache.document;
    }

    const document = await getJson(discoveryUrl);
    for (const field of ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
      if (typeof document[field] !== 'string' || !document[field]) {
        throw new OidcError('provider_response', `Discovery document is missing "${field}".`);
      }
    }

    discoveryCache = { document, expiresAt: Date.now() + DISCOVERY_TTL_MS };
    return document;
  }

  async function getSigningKey(kid) {
    const load = async () => {
      const discovery = await getDiscovery();
      const jwks = await getJson(discovery.jwks_uri);
      jwksCache = { keys: Array.isArray(jwks.keys) ? jwks.keys : [], expiresAt: Date.now() + JWKS_TTL_MS };
      return jwksCache;
    };

    let cache = jwksCache && jwksCache.expiresAt > Date.now() ? jwksCache : await load();
    let jwk = cache.keys.find((key) => !kid || key.kid === kid);

    // An unknown kid is the ordinary shape of key rotation, not an error — the
    // cached set is simply older than the key that signed this token.
    if (!jwk) {
      cache = await load();
      jwk = cache.keys.find((key) => !kid || key.kid === kid);
    }

    if (!jwk) {
      throw new OidcError('unknown_key', `No signing key matches kid "${kid}".`);
    }

    try {
      return crypto.createPublicKey({ key: jwk, format: 'jwk' });
    } catch (error) {
      throw new OidcError('unknown_key', `Signing key ${kid} could not be imported: ${error.message}`);
    }
  }

  /** The redirect URI the provider must have registered, verbatim. */
  function resolveRedirectUri(req) {
    if (config.redirectUri) return config.redirectUri;
    return `${requestOrigin(req)}${CALLBACK_PATH}`;
  }

  /**
   * Starts a login: returns where to send the browser and the secrets that must
   * come back with it.
   */
  async function buildAuthorizationRequest({ redirectUri, returnTo }) {
    const discovery = await getDiscovery();

    const codeVerifier = randomToken(48);
    const flow = {
      state: randomToken(),
      nonce: randomToken(),
      codeVerifier,
      redirectUri,
      returnTo: returnTo || '/',
    };

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: config.clientId,
      redirect_uri: redirectUri,
      scope: config.scopes,
      state: flow.state,
      nonce: flow.nonce,
      code_challenge: base64url(crypto.createHash('sha256').update(codeVerifier).digest()),
      code_challenge_method: 'S256',
    });

    return { url: `${discovery.authorization_endpoint}?${params.toString()}`, flow };
  }

  async function exchangeCode({ code, codeVerifier, redirectUri }) {
    const discovery = await getDiscovery();

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: config.clientId,
      code_verifier: codeVerifier,
    });

    const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    if (config.clientSecret) {
      // client_secret_basic — the only method every provider must support.
      const credentials = `${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`;
      headers.Authorization = `Basic ${Buffer.from(credentials).toString('base64')}`;
    }

    const tokens = await getJson(discovery.token_endpoint, { method: 'POST', headers, body });
    if (typeof tokens.id_token !== 'string' || !tokens.id_token) {
      throw new OidcError('no_id_token', 'Token response carried no id_token — is the "openid" scope granted?');
    }
    return tokens;
  }

  async function verifyIdToken(idToken, { nonce }) {
    const decoded = jwt.decode(idToken, { complete: true });
    if (!decoded || typeof decoded === 'string') {
      throw new OidcError('invalid_token', 'id_token is not a readable JWT.');
    }

    const key = await getSigningKey(decoded.header.kid);
    const discovery = await getDiscovery();

    let claims;
    try {
      claims = jwt.verify(idToken, key, {
        algorithms: SUPPORTED_ALGORITHMS,
        issuer: discovery.issuer,
        audience: config.clientId,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
      });
    } catch (error) {
      throw new OidcError('invalid_token', `id_token rejected: ${error.message}`);
    }

    // Binds the token to *this* login. Without it a token minted for another
    // browser's in-flight request would be accepted here.
    if (claims.nonce !== nonce) {
      throw new OidcError('invalid_token', 'id_token nonce does not match this login.');
    }

    return claims;
  }

  /**
   * Some providers keep the username out of the id_token when the deployment
   * trims scopes, so fall back to the userinfo endpoint before giving up.
   */
  async function fetchUserInfo(accessToken) {
    const discovery = await getDiscovery();
    if (!discovery.userinfo_endpoint || !accessToken) return null;

    try {
      return await getJson(discovery.userinfo_endpoint, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      });
    } catch {
      return null;
    }
  }

  function readUsername(claims) {
    const raw = claims?.[config.usernameClaim];
    return typeof raw === 'string' ? raw.trim() : '';
  }

  /**
   * The VibeSpace username for a verified identity.
   *
   * Deliberately not sanitized: the name is the key into the user map and the
   * value stamped into `X-Vibespace-User`, so quietly rewriting it would route
   * a login to a tenant the operator never named.
   */
  async function resolveUsername(claims, accessToken) {
    let username = readUsername(claims);
    if (!username) {
      const info = await fetchUserInfo(accessToken);
      username = readUsername(info);
    }

    if (!username) {
      throw new OidcError(
        'no_username',
        `No "${config.usernameClaim}" claim on the identity — set VS_OIDC_USERNAME_CLAIM to a claim the provider sends.`,
      );
    }

    if (!USERNAME_PATTERN.test(username)) {
      throw new OidcError(
        'invalid_username',
        `Claim "${config.usernameClaim}" is "${username}", which is not a usable VibeSpace username ` +
          '(letters, digits, "_" and "-" only). Point VS_OIDC_USERNAME_CLAIM at a different claim.',
      );
    }

    return username;
  }

  function isAllowed(username) {
    if (!config.allowedUsers) return true;
    return config.allowedUsers.has(username.toLowerCase());
  }

  async function endSessionUrl({ idToken, postLogoutRedirectUri }) {
    if (!config.endSessionOnLogout) return null;

    const discovery = await getDiscovery().catch(() => null);
    if (!discovery?.end_session_endpoint) return null;

    const params = new URLSearchParams();
    if (idToken) params.set('id_token_hint', idToken);
    if (postLogoutRedirectUri) params.set('post_logout_redirect_uri', postLogoutRedirectUri);

    const query = params.toString();
    return query ? `${discovery.end_session_endpoint}?${query}` : discovery.end_session_endpoint;
  }

  return {
    config,
    getDiscovery,
    resolveRedirectUri,
    buildAuthorizationRequest,
    exchangeCode,
    verifyIdToken,
    resolveUsername,
    isAllowed,
    endSessionUrl,
  };
}
