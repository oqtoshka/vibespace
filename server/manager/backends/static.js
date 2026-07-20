import http from 'http';

/**
 * Static worker backend — the upstream default.
 *
 * Workers are long-running processes the deployment already started (compose
 * services, systemd units), so "starting" one is just resolving its configured
 * address. The lifecycle hooks exist because the manager core calls them on
 * every request; backends that actually own worker processes implement them.
 */

const HEALTH_CACHE_MS = 10_000;
const HEALTH_TIMEOUT_MS = 2000;

export class WorkerUnavailableError extends Error {
  constructor(userId, cause) {
    super(`Worker for "${userId}" is unavailable${cause ? `: ${cause}` : ''}`);
    this.name = 'WorkerUnavailableError';
    this.userId = userId;
  }
}

function probeHealth(host, port) {
  return new Promise((resolve) => {
    const req = http.request(
      { host, port, method: 'GET', path: '/health', timeout: HEALTH_TIMEOUT_MS },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

export function createStaticBackend({ links }) {
  // userId -> { healthyUntil }
  const health = new Map();

  async function getOrStartWorker(link) {
    const url = new URL(link.upstream);
    const entry = {
      host: url.hostname,
      port: Number.parseInt(url.port || (url.protocol === 'https:' ? '443' : '80'), 10),
      workerToken: link.workerToken,
      userId: link.user_id,
    };

    const cached = health.get(link.user_id);
    if (cached && cached.healthyUntil > Date.now()) return entry;

    const healthy = await probeHealth(entry.host, entry.port);
    if (!healthy) {
      health.delete(link.user_id);
      throw new WorkerUnavailableError(link.user_id, `no /health response from ${entry.host}:${entry.port}`);
    }

    health.set(link.user_id, { healthyUntil: Date.now() + HEALTH_CACHE_MS });
    return entry;
  }

  return {
    kind: 'static',
    getOrStartWorker,

    // Static workers outlive the manager, so activity tracking and shutdown are
    // no-ops. Backends that spawn workers use these to drive idle reaping.
    touch() {},
    noteWebSocketOpened() {},
    noteWebSocketClosed() {},

    /** Drop the cached health so the next request re-probes. */
    invalidateWorker(userId) {
      health.delete(userId);
    },

    async stopAll() {},

    listWorkers() {
      return [...links.keys()].map((userId) => ({
        userId,
        upstream: links.get(userId).upstream,
        healthy: (health.get(userId)?.healthyUntil ?? 0) > Date.now(),
      }));
    },
  };
}
