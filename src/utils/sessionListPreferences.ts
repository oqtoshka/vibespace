const CHANGE_EVENT = 'session-list-preferences:change';

/** Browser preference scoped to the authenticated user, like other list preferences. */
export function backgroundRunsStorageKey(userId: string | number): string {
  return `sessionList.${encodeURIComponent(String(userId))}.showBackgroundRuns`;
}

export function readShowBackgroundRuns(userId: string | number): boolean {
  try { return localStorage.getItem(backgroundRunsStorageKey(userId)) === 'true'; }
  catch { return false; }
}

export function writeShowBackgroundRuns(userId: string | number, show: boolean): void {
  localStorage.setItem(backgroundRunsStorageKey(userId), String(show));
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function subscribeSessionListPreferences(listener: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener('storage', listener);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener('storage', listener);
  };
}

/** Defensive filtering for cached pages and websocket deltas; API pagination filters too. */
export function visibleListSessions<T extends { isBackground?: boolean }>(sessions: T[], show = false): T[] {
  return show ? sessions : sessions.filter(session => !session.isBackground);
}
