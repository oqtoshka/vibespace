import { createOidcResolver } from './oidc.js';
import { createPasswordResolver } from './password.js';

/**
 * Identity resolver registry.
 *
 * A resolver turns an incoming request into `{ userId, link }` — everything the
 * manager needs to pick a worker — or an error the core maps to a status code.
 * Upstream ships password auth and OpenID Connect; deployments that authenticate
 * at the edge add their own resolver here (e.g. a client-certificate CN looked
 * up against an identity service) without touching the proxy path.
 *
 * Contract:
 *   resolveUser(req, url) -> { userId, link, refreshedToken? }
 *                          | { error: 'unauthenticated' | 'unmapped' | 'disabled' | 'unavailable' }
 *   resolveSessionCookie(req) -> { userId, link } | null
 *   router -> express.Router mounted at /api/auth, or null when the resolver
 *             owns no login flow.
 */
export function createResolver(kind, deps) {
  switch (kind) {
    case 'password':
      return createPasswordResolver(deps);
    case 'oidc':
      return createOidcResolver(deps);
    default:
      throw new Error(`Unknown VS_MANAGER_AUTH: "${kind}" (expected: password, oidc)`);
  }
}
