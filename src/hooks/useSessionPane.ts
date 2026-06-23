import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * State for the session pane (chat ⇄ terminal), independent of the file tabs.
 *
 * - `view` is remembered **per session** (keyed by session id, with a sentinel
 *   for the not-yet-created "new session"), persisted per project under
 *   `session-view:<projectId>`. Switching sessions restores whatever view that
 *   session last had (defaults to chat).
 * - `open` controls whether the session pane is shown at all (the user can
 *   close it to view files only), persisted per project under
 *   `session-pane-open:<projectId>`.
 * - `width` is the session pane's pixel width in the desktop split, persisted
 *   globally under `session-pane-width`.
 */

export type SessionView = 'chat' | 'terminal';

/** Sentinel session key for the pending "new session" (no id yet). */
export const NEW_SESSION_KEY = '__new__';

const VIEW_PREFIX = 'session-view:';
const OPEN_PREFIX = 'session-pane-open:';
const WIDTH_KEY = 'session-pane-width';

export const SESSION_PANE_MIN_WIDTH = 320;

type ViewMap = Record<string, SessionView>;

function loadViewMap(projectId: string): ViewMap {
  try {
    const raw = localStorage.getItem(`${VIEW_PREFIX}${projectId}`);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as ViewMap;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function loadOpen(projectId: string): boolean {
  try {
    return localStorage.getItem(`${OPEN_PREFIX}${projectId}`) !== 'false';
  } catch {
    return true;
  }
}

function loadWidth(): number | null {
  try {
    const stored = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(stored) && stored >= SESSION_PANE_MIN_WIDTH ? stored : null;
  } catch {
    return null;
  }
}

export type UseSessionPaneResult = {
  getView: (sessionKey: string) => SessionView;
  setView: (sessionKey: string, view: SessionView) => void;
  isOpen: boolean;
  setOpen: (open: boolean) => void;
  width: number | null;
  setWidth: (width: number) => void;
};

export function useSessionPane(projectId: string | null): UseSessionPaneResult {
  const [viewMap, setViewMap] = useState<ViewMap>(() => (projectId ? loadViewMap(projectId) : {}));
  const [isOpen, setIsOpen] = useState<boolean>(() => (projectId ? loadOpen(projectId) : true));
  const [width, setWidthState] = useState<number | null>(loadWidth);

  // Swap state synchronously when the project changes (mirrors useWorkspaceTabs)
  // so no render pairs a new project with another project's session-pane state.
  const projectRef = useRef<string | null>(projectId);
  if (projectRef.current !== projectId) {
    projectRef.current = projectId;
    setViewMap(projectId ? loadViewMap(projectId) : {});
    setIsOpen(projectId ? loadOpen(projectId) : true);
  }

  useEffect(() => {
    if (!projectId) return;
    try {
      localStorage.setItem(`${VIEW_PREFIX}${projectId}`, JSON.stringify(viewMap));
    } catch {
      // Ignore storage errors.
    }
  }, [projectId, viewMap]);

  useEffect(() => {
    if (!projectId) return;
    try {
      localStorage.setItem(`${OPEN_PREFIX}${projectId}`, String(isOpen));
    } catch {
      // Ignore storage errors.
    }
  }, [projectId, isOpen]);

  useEffect(() => {
    if (width === null) return;
    try {
      localStorage.setItem(WIDTH_KEY, String(Math.round(width)));
    } catch {
      // Ignore storage errors.
    }
  }, [width]);

  const getView = useCallback(
    (sessionKey: string): SessionView => viewMap[sessionKey] ?? 'chat',
    [viewMap],
  );

  const setView = useCallback((sessionKey: string, view: SessionView) => {
    setViewMap((prev) => (prev[sessionKey] === view ? prev : { ...prev, [sessionKey]: view }));
  }, []);

  const setOpen = useCallback((open: boolean) => setIsOpen(open), []);
  const setWidth = useCallback((next: number) => setWidthState(next), []);

  return { getView, setView, isOpen, setOpen, width, setWidth };
}
