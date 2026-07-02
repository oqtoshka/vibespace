import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { dbg } from '../utils/debugLog';
import type { CodeEditorDiffInfo } from '../components/code-editor/types/types';
import { isPanelId, type WorkspacePanel, type WorkspaceTab } from '../types/workspace';

/** Compact tab summary for debug logs (avoids dumping full objects). */
function summarizeTabs(tabs: WorkspaceTab[]): string {
  return tabs.map((tab) => `file:${tab.name}`).join(',');
}

/**
 * Per-project VSCode-like workspace tabs — files only. Chat and terminal live
 * in the dedicated session pane (toggled per session); Files/Git/Tasks/plugins
 * remain singleton panels sharing the same selection space as file tabs.
 *
 * Persistence: one localStorage blob per project under
 * `workspace-tabs:<projectId>`. The legacy global `activeTab` key is
 * discarded on first run (its singleton semantics don't map to tabs).
 *
 * Mutators compute the next state synchronously from a ref mirror (and then
 * push it to React state), so callers get the created tab id back immediately
 * and sequential calls within one event tick observe each other's writes.
 */

type WorkspaceState = {
  tabs: WorkspaceTab[];
  /** A file tab id, a panel id, or null when nothing is selected (right pane collapsed). */
  activeId: string | null;
};

type PersistedWorkspaceState = WorkspaceState & { version: 1 };

export type UseWorkspaceTabsResult = {
  tabs: WorkspaceTab[];
  activeId: string | null;
  /** Resolved active workspace tab, or null when a panel (or nothing) is active. */
  activeTab: WorkspaceTab | null;
  /** Active panel id, or null when a file tab (or nothing) is active. */
  activePanel: WorkspacePanel | null;
  openFileTab: (path: string, name?: string, diffInfo?: CodeEditorDiffInfo | null) => string;
  setActive: (id: string) => void;
  closeTab: (id: string) => void;
  /** Deactivates the active panel (git/browser/…), falling back to the last file tab. */
  closePanel: () => void;
};

const STORAGE_PREFIX = 'workspace-tabs:';
const LEGACY_ACTIVE_TAB_KEY = 'activeTab';

let legacyKeyMigrated = false;

function migrateLegacyActiveTab(): void {
  if (legacyKeyMigrated) {
    return;
  }
  legacyKeyMigrated = true;
  try {
    localStorage.removeItem(LEGACY_ACTIVE_TAB_KEY);
  } catch {
    // Storage unavailable — nothing to migrate.
  }
}

function generateTabId(): string {
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
      : Math.random().toString(36).slice(2, 14);
  return `tab_${random}`;
}

function fileNameFromPath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  return normalized.split('/').pop() || path;
}

/** Fresh project state: no file tabs, nothing active (session pane fills the view). */
function seedState(): WorkspaceState {
  return { tabs: [], activeId: null };
}

function isValidTab(value: unknown): value is WorkspaceTab {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const tab = value as Record<string, unknown>;
  if (typeof tab.id !== 'string' || !tab.id.startsWith('tab_')) {
    return false;
  }
  // Only file tabs survive now; legacy chat/shell tabs are dropped on load.
  return tab.kind === 'file' && typeof tab.path === 'string' && typeof tab.name === 'string';
}

function loadState(projectId: string): WorkspaceState {
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${projectId}`);
    if (!raw) {
      return seedState();
    }
    const parsed = JSON.parse(raw) as PersistedWorkspaceState;
    if (parsed.version !== 1 || !Array.isArray(parsed.tabs)) {
      return seedState();
    }
    const tabs = parsed.tabs.filter(isValidTab);
    const activeId =
      typeof parsed.activeId === 'string' &&
        (isPanelId(parsed.activeId) || tabs.some((tab) => tab.id === parsed.activeId))
        ? parsed.activeId
        : (tabs[0]?.id ?? null);
    return { tabs, activeId };
  } catch {
    // Corrupted blob — reset this project's workspace.
    return seedState();
  }
}

function persistState(projectId: string, state: WorkspaceState): void {
  try {
    const payload: PersistedWorkspaceState = { version: 1, ...state };
    localStorage.setItem(`${STORAGE_PREFIX}${projectId}`, JSON.stringify(payload));
  } catch {
    // Quota/unavailable — tabs become session-only, which is acceptable.
  }
}

const EMPTY_STATE: WorkspaceState = { tabs: [], activeId: null };

export function useWorkspaceTabs({ projectId }: { projectId: string | null }): UseWorkspaceTabsResult {
  const [state, setState] = useState<WorkspaceState>(() => {
    migrateLegacyActiveTab();
    return projectId ? loadState(projectId) : EMPTY_STATE;
  });

  // Synchronous mirror of `state`; every mutation goes through applyState so
  // mutators can read fresh data and return ids in the same tick.
  const stateRef = useRef(state);
  // Tracks which project the in-memory state belongs to so the swap and
  // persist effects never cross-write between projects.
  const stateProjectIdRef = useRef<string | null>(projectId);

  const applyState = useCallback((next: WorkspaceState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  // Swap to the new project's tabs synchronously during render (not in an
  // effect) so no render ever pairs the new project with the old project's
  // tabs.
  if (stateProjectIdRef.current !== projectId) {
    dbg('tabs.swap', {
      from: stateProjectIdRef.current,
      to: projectId,
      loadedTabs: projectId ? summarizeTabs(loadState(projectId).tabs) : '',
    });
    stateProjectIdRef.current = projectId;
    const next = projectId ? loadState(projectId) : EMPTY_STATE;
    stateRef.current = next;
    setState(next);
  }

  useEffect(() => {
    if (projectId && stateProjectIdRef.current === projectId) {
      persistState(projectId, state);
    }
  }, [projectId, state]);

  const openFileTab = useCallback(
    (path: string, name?: string, diffInfo: CodeEditorDiffInfo | null = null): string => {
      const previous = stateRef.current;
      const existing = previous.tabs.find((tab) => tab.path === path);

      if (existing) {
        // Re-opens refresh the diff (e.g. a newer quick-diff from chat).
        const tabs = previous.tabs.map((tab) =>
          tab.id === existing.id ? { ...tab, diffInfo } : tab,
        );
        applyState({ tabs, activeId: existing.id });
        return existing.id;
      }

      const tab: WorkspaceTab = {
        id: generateTabId(),
        kind: 'file',
        path,
        name: name || fileNameFromPath(path),
        diffInfo,
      };
      applyState({ tabs: [...previous.tabs, tab], activeId: tab.id });
      return tab.id;
    },
    [applyState],
  );

  const setActive = useCallback(
    (id: string) => {
      const previous = stateRef.current;
      if (previous.activeId === id) {
        return;
      }
      if (!isPanelId(id) && !previous.tabs.some((tab) => tab.id === id)) {
        return;
      }
      dbg('tabs.setActive', { from: previous.activeId, to: id, project: stateProjectIdRef.current });
      applyState({ ...previous, activeId: id });
    },
    [applyState],
  );

  const closeTab = useCallback(
    (id: string) => {
      const previous = stateRef.current;
      const index = previous.tabs.findIndex((tab) => tab.id === id);
      if (index === -1) {
        return;
      }
      const tabs = previous.tabs.filter((tab) => tab.id !== id);
      let activeId = previous.activeId;
      if (activeId === id) {
        // Prefer the left neighbor, then right; null collapses the right pane
        // (the session pane then fills the view).
        const neighbor = tabs[index - 1] ?? tabs[index];
        activeId = neighbor ? neighbor.id : null;
      }
      dbg('tabs.close', {
        closed: id,
        wasActive: previous.activeId === id,
        newActive: activeId,
        project: stateProjectIdRef.current,
        before: summarizeTabs(previous.tabs),
        after: summarizeTabs(tabs),
      });
      applyState({ tabs, activeId });
    },
    [applyState],
  );

  const closePanel = useCallback(() => {
    const previous = stateRef.current;
    if (!previous.activeId || !isPanelId(previous.activeId)) {
      return;
    }
    // Panels aren't tabs, so there's no neighbor to pick — fall back to the
    // last file tab; null collapses the right pane like closing the last tab.
    const fallback = previous.tabs[previous.tabs.length - 1]?.id ?? null;
    dbg('tabs.closePanel', { closed: previous.activeId, newActive: fallback, project: stateProjectIdRef.current });
    applyState({ ...previous, activeId: fallback });
  }, [applyState]);

  const activeTab = useMemo(
    () => state.tabs.find((tab) => tab.id === state.activeId) ?? null,
    [state.activeId, state.tabs],
  );

  const activePanel = useMemo(
    () => (state.activeId && isPanelId(state.activeId) ? state.activeId : null),
    [state.activeId],
  );

  return {
    tabs: state.tabs,
    activeId: state.activeId,
    activeTab,
    activePanel,
    openFileTab,
    setActive,
    closeTab,
    closePanel,
  };
}
