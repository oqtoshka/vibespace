import { appConfigDb, sessionsDb, userDb } from '@/modules/database/index.js';

import { decodeSessionCapability, decodeSideCapability, encodeSessionCapability, encodeSideCapability } from './capability-codec.js';

/** Native control issues owner-only credentials independently of browser JWTs and reporters. */
export function issueSessionCapability(sessionId: string): string {
  return encodeSessionCapability(sessionId, appConfigDb.getOrCreateSessionCapabilitySecret());
}

/** Native WebSocket and private integration host validate v2 only; persistence errors fail closed. */
export function sessionCapabilityExpiry(sessionId: string, supplied: unknown): number | null {
  try { return decodeSessionCapability(sessionId, supplied, appConfigDb.getOrCreateSessionCapabilitySecret()); }
  catch { return null; }
}

/** Plugin host authenticates against current privacy and operator state as well as the signature. */
export function authorizeSessionCapability(sessionId: string, supplied: unknown): boolean {
  try {
    if (sessionCapabilityExpiry(sessionId, supplied) === null || !userDb.getSingleActiveUser()) return false;
    const row = sessionsDb.getSessionById(sessionId);
    return !!row && row.is_private === 0 && row.is_side === 0;
  } catch { return false; }
}

/** Native control issues the send-only credential for one native side question. */
export function issueSideCapability(sessionId: string): string {
  return encodeSideCapability(sessionId, appConfigDb.getOrCreateSessionCapabilitySecret());
}

/** Native WebSocket accepts a side credential only while the row is still an
 * unpromoted native side question whose parent is not private. Fails closed. */
export function sideCapabilityExpiry(sessionId: string, supplied: unknown): number | null {
  try {
    const expires = decodeSideCapability(sessionId, supplied, appConfigDb.getOrCreateSessionCapabilitySecret());
    if (expires === null) return null;
    const row = sessionsDb.getSessionById(sessionId);
    if (!row || row.is_side !== 1 || row.is_private !== 0) return null;
    const parentId = sessionsDb.getSideParent(sessionId);
    const parent = parentId ? sessionsDb.getSessionById(parentId) : null;
    return parent && parent.is_private === 0 ? expires : null;
  } catch { return null; }
}
