import type { VerifyClientCallbackSync } from 'ws';

import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';

type AuthenticatedUser = {
  id?: string | number;
  userId?: string | number;
  username?: string;
  [key: string]: unknown;
};

type WebSocketAuthDependencies = {
  isPlatform: boolean;
  authenticateWebSocket: (token: string | null) => AuthenticatedUser | null;
  /** True when this process is a per-user worker behind the manager. */
  isWorkerMode?: boolean;
  /**
   * Resolves the manager-stamped identity off the upgrade request, or null when
   * the headers aren't trustworthy. Supplied by the auth middleware so the
   * token check and user auto-provisioning stay in one place.
   */
  resolveWorkerUser?: (request: AuthenticatedWebSocketRequest) => AuthenticatedUser | null;
};

/**
 * Authenticates websocket upgrade requests before the `connection` handler runs.
 *
 * Always accepts the upgrade: rejecting the handshake surfaces client-side as
 * an opaque close (indistinguishable from a network blip), which made clients
 * with an expired JWT reconnect forever. Instead `request.user` is left unset
 * on auth failure and the connection handler closes the socket with an
 * app-level code the client can act on (re-login instead of retrying).
 */
export function verifyWebSocketClient(
  info: Parameters<VerifyClientCallbackSync<AuthenticatedWebSocketRequest>>[0],
  dependencies: WebSocketAuthDependencies
): boolean {
  const request = info.req as AuthenticatedWebSocketRequest;
  const upgradeUrl = new URL(request.url ?? '/', 'http://localhost');
  const loggedUrl = new URL(upgradeUrl);
  if (loggedUrl.searchParams.has('token')) {
    loggedUrl.searchParams.set('token', 'REDACTED');
  }

  console.log('WebSocket connection attempt to:', `${loggedUrl.pathname}${loggedUrl.search}`);

  // Worker mode: identity comes from the header the manager stamped after it
  // authenticated the user. Leaving `user` unset on failure keeps the existing
  // contract — the connection handler closes with the app-level auth code.
  if (dependencies.isWorkerMode) {
    const user = dependencies.resolveWorkerUser?.(request) ?? null;
    if (!user) {
      console.log(`[WARN] Worker mode: unauthenticated WebSocket upgrade (${loggedUrl.pathname})`);
      return true;
    }

    request.user = user;
    console.log('[OK] Worker mode WebSocket authenticated for user:', user.username);
    return true;
  }

  // Platform mode: use the first DB user and skip token checks.
  if (dependencies.isPlatform) {
    const user = dependencies.authenticateWebSocket(null);
    if (!user) {
      console.log('[WARN] Platform mode: No user found in database');
      return true;
    }

    request.user = user;
    console.log('[OK] Platform mode WebSocket authenticated for user:', user.username);
    return true;
  }

  // OSS mode: read JWT from query string first, then Authorization header.
  const token =
    upgradeUrl.searchParams.get('token') ??
    request.headers.authorization?.split(' ')[1] ??
    null;

  const user = dependencies.authenticateWebSocket(token);
  const clientIp =
    (request.headers['x-real-ip'] as string | undefined) ??
    (request.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ??
    request.socket?.remoteAddress ??
    'unknown';

  if (!user) {
    // Decode (without verifying) so the log says WHICH client keeps knocking
    // with a dead token — stale tabs can loop for days and the bare WARN made
    // them impossible to tell apart.
    let tokenInfo = 'no-token';
    if (token) {
      try {
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
        tokenInfo = `user=${payload.username ?? '?'} exp=${
          payload.exp ? new Date(payload.exp * 1000).toISOString() : '?'
        }`;
      } catch {
        tokenInfo = 'malformed-token';
      }
    }
    console.log(`[WARN] WebSocket authentication failed (${loggedUrl.pathname}, ip=${clientIp}, ${tokenInfo})`);
    return true;
  }

  request.user = user;
  console.log(`[OK] WebSocket authenticated for user: ${user.username} (${loggedUrl.pathname}, ip=${clientIp})`);
  return true;
}
