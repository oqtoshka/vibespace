import { appConfigDb, sessionsDb, userDb } from '@/modules/database/index.js';

import { decodeSessionCapability, encodeSessionCapability } from './capability-codec.js';

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
