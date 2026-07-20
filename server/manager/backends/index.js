import { createStaticBackend } from './static.js';

/**
 * Worker backend registry.
 *
 * A backend maps a user link to a reachable worker address. Upstream ships the
 * static backend (workers the deployment already runs); backends that own
 * worker processes — forking them on the host, or spawning a container per
 * tenant — implement the same interface and are selected via VS_WORKER_BACKEND.
 *
 * Contract:
 *   getOrStartWorker(link) -> Promise<{ host, port, workerToken?, userId }>
 *   touch(userId)                      — request activity, for idle tracking
 *   noteWebSocketOpened/Closed(userId) — live-session tracking; a worker with an
 *                                        open socket must never be reaped
 *   invalidateWorker(userId, entry)    — the proxy saw this worker fail
 *   stopAll()                          — shutdown
 *
 * The manager core calls every hook at the right point regardless of backend,
 * so a lifecycle-owning backend is a drop-in replacement.
 */
export function createBackend(kind, deps) {
  switch (kind) {
    case 'static':
      return createStaticBackend(deps);
    default:
      throw new Error(`Unknown VS_WORKER_BACKEND: "${kind}" (expected: static)`);
  }
}
