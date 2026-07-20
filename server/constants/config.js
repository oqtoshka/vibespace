/**
 * Environment Flag: Is Platform
 * Indicates if the app is running in Platform mode (hosted) or OSS mode (self-hosted)
 */
export const IS_PLATFORM = process.env.VITE_IS_PLATFORM === 'true';

/**
 * Deployment mode — normalized in load-env.js before anything imports this.
 * See that file for the meaning of each value.
 */
export const VIBESPACE_MODE = process.env.VIBESPACE_MODE || 'local';

/** This process is the manager fronting per-user workers. */
export const IS_MULTI_MODE = VIBESPACE_MODE === 'multi';

/** This process is a per-user worker; the manager is its only legitimate client. */
export const IS_WORKER_MODE = VIBESPACE_MODE === 'worker';

/** Either half of a manager-fronted deployment. */
export const IS_MANAGED_MODE = IS_MULTI_MODE || IS_WORKER_MODE;

/**
 * Per-hop identity header. The manager strips any client-supplied copy and
 * re-stamps it with the username it authenticated, so a worker can trust it.
 */
export const WORKER_USER_HEADER = 'x-vibespace-user';

/**
 * Shared secret proving a request came from the manager rather than from a
 * neighbour on the same network. Workers enforce it when VS_WORKER_TOKEN is set.
 */
export const WORKER_TOKEN_HEADER = 'x-vibespace-worker-token';