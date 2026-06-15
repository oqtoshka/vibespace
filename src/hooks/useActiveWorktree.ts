import { useCallback, useEffect, useState } from 'react';

/**
 * Per-project "active worktree" selection — which git worktree new sessions
 * (and the terminal) run in. Persisted in localStorage, mirrored across the git
 * panel (writer) and the chat composer (reader) via a window event, like
 * useUiPreferences.
 *
 * `null` means the project's main checkout.
 */

export type ActiveWorktree = { path: string; branch: string | null } | null;

const STORAGE_PREFIX = 'git-active-worktree:';
const SYNC_EVENT = 'active-worktree:sync';

function storageKey(projectId: string) {
  return `${STORAGE_PREFIX}${projectId}`;
}

export function readActiveWorktree(projectId?: string | null): ActiveWorktree {
  if (!projectId) return null;
  try {
    const raw = localStorage.getItem(storageKey(projectId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.path === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

function writeActiveWorktree(projectId: string, value: ActiveWorktree): void {
  try {
    if (value) {
      localStorage.setItem(storageKey(projectId), JSON.stringify(value));
    } else {
      localStorage.removeItem(storageKey(projectId));
    }
  } catch {
    // storage unavailable — keep runtime behavior via the event below
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(SYNC_EVENT, { detail: { projectId } }));
  }
}

/**
 * Stable per-session cwd binding (module-level, lives for the page session).
 *
 * A brand-new session's id changes from null → real between its first and
 * second message, and the server-synced `worktreePath` arrives only after a
 * projects refresh — so without this binding, message 2 would fall back to the
 * main checkout. We pin the cwd to the session id once known. After a reload the
 * map is empty, but the session's `worktreePath` is then available from the API.
 */
const sessionCwdBindings = new Map<string, string>();

export function bindSessionCwd(sessionId: string | null | undefined, cwd: string): void {
  if (sessionId) sessionCwdBindings.set(sessionId, cwd);
}

export function getSessionCwd(sessionId: string | null | undefined): string | null {
  return sessionId ? sessionCwdBindings.get(sessionId) ?? null : null;
}

export function useActiveWorktree(projectId?: string | null) {
  const [activeWorktree, setActiveWorktreeState] = useState<ActiveWorktree>(() => readActiveWorktree(projectId));

  useEffect(() => {
    setActiveWorktreeState(readActiveWorktree(projectId));
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return undefined;
    const onSync = (event: Event) => {
      const detail = (event as CustomEvent).detail as { projectId?: string } | undefined;
      if (detail?.projectId === projectId) {
        setActiveWorktreeState(readActiveWorktree(projectId));
      }
    };
    window.addEventListener(SYNC_EVENT, onSync);
    return () => window.removeEventListener(SYNC_EVENT, onSync);
  }, [projectId]);

  const setActiveWorktree = useCallback(
    (next: ActiveWorktree) => {
      if (projectId) writeActiveWorktree(projectId, next);
    },
    [projectId],
  );

  return { activeWorktree, setActiveWorktree };
}
