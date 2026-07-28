import http from 'http';

import { WORKER_USER_HEADER, WORKER_TOKEN_HEADER } from '../constants/config.js';

/**
 * Routing for public share links.
 *
 * A share link carries no identity: the whole point is that anyone holding the
 * URL can open it without logging in. That leaves the manager with nothing to
 * route on — the shareId lives in one tenant's worker database and the manager
 * keeps no database of its own. Falling back to the session cookie (what this
 * used to do) sends the request to whichever tenant happens to be logged in,
 * so a link only ever worked for the person who minted it.
 *
 * So we ask. On a cache miss the manager probes every enabled worker's
 * `/api/share/:shareId/meta` and keeps the one that claims it. The shareId is
 * 24 random bytes and is itself the capability, so offering it to each worker
 * discloses nothing a holder of the link doesn't already have; a worker that
 * doesn't own it answers 404 and learns only that someone asked.
 *
 * Ownership never moves — the id is minted with the row — so a hit is cached
 * outright. Revocation and expiry are still decided by the owning worker on
 * every request, which keeps answering through the same mapping.
 *
 * Discovery deliberately bypasses the backend's health gate and talks to the
 * configured address directly. A worker busy enough to miss a 2s health probe
 * is still the only place its shares exist, and answering "this link is
 * invalid" because its owner was mid-agent-turn is worse than waiting. Whether
 * the worker is *fit to proxy to* is a separate question the normal request
 * path already asks.
 */

const SHARE_PATH = /^\/api\/share\/([^/]+)(?:\/|$)/;

const OWNER_TTL_MS = 60 * 60 * 1000;
const MAX_CACHED_OWNERS = 4096;
const PROBE_TIMEOUT_MS = 8000;

/** The shareId in `/api/share/:shareId/...`, or null for any other path. */
export function shareIdFromPath(pathname) {
  const match = SHARE_PATH.exec(pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function addressOf(link) {
  const url = new URL(link.upstream);
  return {
    host: url.hostname,
    port: Number.parseInt(url.port || (url.protocol === 'https:' ? '443' : '80'), 10),
    workerToken: link.workerToken,
    userId: link.user_id,
  };
}

/**
 * 200 = owns it, 410 = owns it but the file is gone (still the right worker to
 * serve the error), 404 = not this worker's share. `answered: false` means the
 * worker never replied, which is not the same as saying no.
 */
function probeWorker(address, shareId) {
  return new Promise((resolve) => {
    const headers = { [WORKER_USER_HEADER]: address.userId };
    if (address.workerToken) headers[WORKER_TOKEN_HEADER] = address.workerToken;

    const req = http.request(
      {
        host: address.host,
        port: address.port,
        method: 'GET',
        path: `/api/share/${encodeURIComponent(shareId)}/meta`,
        headers,
        timeout: PROBE_TIMEOUT_MS,
      },
      (res) => {
        res.resume();
        resolve({ owns: res.statusCode === 200 || res.statusCode === 410, answered: true });
      }
    );
    req.on('error', () => resolve({ owns: false, answered: false }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ owns: false, answered: false });
    });
    req.end();
  });
}

export function createShareOwnerIndex({ links, probe = probeWorker }) {
  // shareId -> { userId, expiresAt }
  const cache = new Map();

  function remember(shareId, userId) {
    // Insertion-ordered eviction: this is a lookup cache, not a session store,
    // and a re-probe costs one round trip.
    if (cache.size >= MAX_CACHED_OWNERS) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(shareId, { userId, expiresAt: Date.now() + OWNER_TTL_MS });
  }

  /**
   * @returns {Promise<{ userId: string|null, conclusive: boolean }>} — a null
   *   userId is only trustworthy when `conclusive`, i.e. every enabled worker
   *   actually answered and none claimed the share. If any stayed silent the
   *   answer is unknown, and the caller must not report the link as dead.
   */
  async function findOwner(shareId) {
    const cached = cache.get(shareId);
    if (cached) {
      if (cached.expiresAt > Date.now()) return { userId: cached.userId, conclusive: true };
      cache.delete(shareId);
    }

    const candidates = [...links.values()].filter((link) => link.enabled);
    const results = await Promise.all(
      candidates.map(async (link) => {
        let address;
        try {
          address = addressOf(link);
        } catch {
          return { owns: false, answered: false, userId: link.user_id };
        }
        const outcome = await probe(address, shareId);
        return { ...outcome, userId: link.user_id };
      })
    );

    const owner = results.find((result) => result.owns);
    if (owner) {
      remember(shareId, owner.userId);
      return { userId: owner.userId, conclusive: true };
    }

    return { userId: null, conclusive: results.every((result) => result.answered) };
  }

  return { findOwner, forget: (shareId) => cache.delete(shareId), size: () => cache.size };
}
