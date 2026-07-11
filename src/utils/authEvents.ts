/**
 * Window-level auth events bridging the plain-fetch layer (`utils/api.js`) and
 * React state (`AuthContext`). The fetch helper can't reach React context, so
 * it broadcasts and the provider listens.
 */

/** Fired with `detail: string` (the new JWT) when a response carries X-Refreshed-Token. */
export const AUTH_TOKEN_REFRESHED_EVENT = 'vibespace:auth-token-refreshed';

/** Fired when a response proves the stored JWT is expired/invalid — time to re-login. */
export const AUTH_SESSION_EXPIRED_EVENT = 'vibespace:auth-session-expired';

/**
 * App-level websocket close code the server sends when the connection's JWT
 * failed verification (mirrored in `server/.../websocket-server.service.ts`).
 * On this code, reconnecting with the same token is pointless — fire
 * AUTH_SESSION_EXPIRED_EVENT instead so the login screen renders.
 */
export const WS_CLOSE_CODE_AUTH_FAILED = 4401;
