import type { SessionWithProvider } from '../types/types';

import { getSessionDate } from './utils';

/**
 * Per-session "read receipts" used by the activity view's unread detection.
 *
 * There is no backend notion of read/unread, so we persist a local map of
 * `sessionId -> last-opened epoch ms`. A session is considered unread when its
 * latest activity is newer than the last time the user opened it (or it has
 * activity and was never opened).
 */
export type SessionReadMap = Record<string, number>;

const STORAGE_KEY = 'sidebar-session-read-state';

export const readSessionReadMap = (): SessionReadMap => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return {};
    }

    const result: SessionReadMap = {};
    for (const [sessionId, value] of Object.entries(parsed as Record<string, unknown>)) {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) {
        result[sessionId] = numeric;
      }
    }
    return result;
  } catch {
    return {};
  }
};

export const writeSessionReadMap = (map: SessionReadMap): void => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Keep the UI responsive even if storage is unavailable/full.
  }
};

/**
 * A session is unread when it has activity the user hasn't seen since they last
 * opened it. The currently-selected session is always treated as read.
 */
export const isSessionUnread = (
  session: SessionWithProvider,
  readMap: SessionReadMap,
  selectedSessionId: string | null,
): boolean => {
  if (session.id === selectedSessionId) {
    return false;
  }

  const activity = getSessionDate(session).getTime();
  if (!activity) {
    return false;
  }

  const readAt = readMap[session.id];
  if (readAt === undefined) {
    // Never opened but has activity — surface it as something to look at.
    return true;
  }

  return activity > readAt;
};
