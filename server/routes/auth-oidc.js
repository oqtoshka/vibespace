import { createOidcClient, loadOidcConfig } from '../shared/oidc.js';
import { createOidcRouter } from '../shared/oidc-routes.js';
import { userDb } from '../modules/database/index.js';
import { generateToken, JWT_SECRET } from '../middleware/auth.js';
import { IS_WORKER_MODE } from '../constants/config.js';

/**
 * OpenID Connect sign-in for the single-user server.
 *
 * The manager has a resolver seam for this; a laptop or single-tenant install
 * does not, so the flow is mounted straight onto `/api/auth`. Everything up to
 * a verified username is the shared code path — only the last step differs:
 * here the identity is bound to the one local user row and handed the same JWT
 * `authenticateToken` already understands, so sessions, WebSocket auth and
 * token refresh keep working untouched.
 */

/**
 * The configured provider, or null when this install stays on password auth.
 *
 * Worker mode is excluded outright: its identity arrives stamped by the
 * manager, and a second way in would be a second thing to get wrong.
 */
export const LOCAL_OIDC_CONFIG = (() => {
  if (IS_WORKER_MODE) return null;

  const config = loadOidcConfig();
  if (!config) return null;

  if (!config.allowedUsers || config.allowedUsers.size === 0) {
    throw new Error(
      'VS_OIDC_ISSUER is set but VS_OIDC_ALLOWED_USERS is empty. An identity provider ' +
        'usually serves more than this one app, so without an allow-list every account ' +
        'in the directory could sign in. Set VS_OIDC_ALLOWED_USERS to the username that owns this install.'
    );
  }

  return config;
})();

export const isLocalOidcEnabled = () => LOCAL_OIDC_CONFIG !== null;

/**
 * Binds a verified identity to this install's single user.
 *
 * First sign-in provisions the row; after that the username must match. The
 * stored hash is the same placeholder worker mode uses — no bcrypt comparison
 * can ever match it, so the password endpoints cannot be talked back open.
 */
function resolveLocalUser(username) {
  const existing = userDb.getUserByUsername(username);
  if (existing) {
    return { user: userDb.getUserById(existing.id) };
  }

  if (userDb.hasUsers()) {
    return {
      error: 'unmapped',
      message: `"${username}" is not the user this VibeSpace belongs to.`,
    };
  }

  const created = userDb.createUser(username, 'managed:no-password');
  return { user: userDb.getUserById(created.id) };
}

export function createLocalOidcRouter() {
  const config = LOCAL_OIDC_CONFIG;
  if (!config) return null;

  const client = createOidcClient(config);

  return createOidcRouter({
    client,
    // The flow cookie is sealed with the same key that signs sessions, so a
    // forged in-flight login is no easier to mint than a forged session.
    flowSecret: JWT_SECRET,
    cookieSecure: config.cookieSecure,
    logPrefix: 'oidc',
    authenticate: ({ username }) => {
      const resolved = resolveLocalUser(username);
      if (resolved.error) return resolved;

      return { token: generateToken(resolved.user) };
    },
  });
}
