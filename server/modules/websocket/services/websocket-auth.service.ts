import type { VerifyClientCallbackSync } from 'ws';

import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';

type WebSocketAuthDependencies = {
  isPlatform: boolean;
  authenticateWebSocket: (token: string | null) => {
    id?: string | number;
    userId?: string | number;
    username?: string;
    [key: string]: unknown;
  } | null;
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
