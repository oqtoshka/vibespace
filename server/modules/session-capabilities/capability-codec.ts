import { createHmac, timingSafeEqual } from 'node:crypto';

const lifetimeSeconds = 15 * 60;
const validSession = (id: string) => id.length > 0 && id.length <= 120 && !/[^a-zA-Z0-9._-]/.test(id);
const tokenPattern = /^v2\.([1-9][0-9]{0,10})\.([1-9][0-9]{0,10})\.([A-Za-z0-9_-]{43})$/;

function signature(secret: string, id: string, issued: number, expires: number): string {
  return createHmac('sha256', secret)
    .update(`mission-control:vibespace-session:v2:${id}:${issued}:${expires}`).digest('base64url');
}

/** Capability service encodes a fixed-lifetime session credential; timestamps are owner time. */
export function encodeSessionCapability(id: string, secret: string, now = Date.now()): string {
  const issued = Math.floor(now / 1000);
  if (!validSession(id) || !Number.isSafeInteger(issued) || issued <= 0) throw new Error('Invalid capability input');
  const expires = issued + lifetimeSeconds;
  return `v2.${issued}.${expires}.${signature(secret, id, issued, expires)}`;
}

/** Capability service returns the authenticated expiry in milliseconds or null, never a parsed but unverified timestamp. */
export function decodeSessionCapability(id: string, value: unknown, secret: string, now = Date.now()): number | null {
  if (!validSession(id) || typeof value !== 'string' || value.length > 80 || !Number.isFinite(now)) return null;
  const match = tokenPattern.exec(value);
  if (!match || match[0] !== value) return null;
  const issued = Number(match[1]), expires = Number(match[2]);
  if (expires - issued !== lifetimeSeconds || now < issued * 1000 || now >= expires * 1000) return null;
  const expected = signature(secret, id, issued, expires);
  // Strict ASCII/base64url grammar makes both comparison buffers exactly43 bytes.
  return timingSafeEqual(Buffer.from(match[3], 'ascii'), Buffer.from(expected, 'ascii')) ? expires * 1000 : null;
}

// Native side questions (FEAT-SESSION-030) get their own grammar and HMAC
// domain, so a side credential can never be replayed as an owner capability
// for any session, and an owner capability can never open a side socket.
// It lives as long as the panel that asked it may (the 24-hour sweep bound);
// Mission Control renews only `v2.` values, so it never tries to renew this one.
const sideLifetimeSeconds = 24 * 60 * 60;
const sideTokenPattern = /^side1\.([1-9][0-9]{0,10})\.([1-9][0-9]{0,10})\.([A-Za-z0-9_-]{43})$/;

function sideSignature(secret: string, id: string, issued: number, expires: number): string {
  return createHmac('sha256', secret)
    .update(`mission-control:vibespace-side-session:v1:${id}:${issued}:${expires}`).digest('base64url');
}

/** Side-question service encodes a send-only credential bound to one side session. */
export function encodeSideCapability(id: string, secret: string, now = Date.now()): string {
  const issued = Math.floor(now / 1000);
  if (!validSession(id) || !Number.isSafeInteger(issued) || issued <= 0) throw new Error('Invalid capability input');
  const expires = issued + sideLifetimeSeconds;
  return `side1.${issued}.${expires}.${sideSignature(secret, id, issued, expires)}`;
}

/** Returns the authenticated expiry in milliseconds, or null. */
export function decodeSideCapability(id: string, value: unknown, secret: string, now = Date.now()): number | null {
  if (!validSession(id) || typeof value !== 'string' || value.length > 90 || !Number.isFinite(now)) return null;
  const match = sideTokenPattern.exec(value);
  if (!match || match[0] !== value) return null;
  const issued = Number(match[1]), expires = Number(match[2]);
  if (expires - issued !== sideLifetimeSeconds || now < issued * 1000 || now >= expires * 1000) return null;
  const expected = sideSignature(secret, id, issued, expires);
  return timingSafeEqual(Buffer.from(match[3], 'ascii'), Buffer.from(expected, 'ascii')) ? expires * 1000 : null;
}
