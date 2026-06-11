import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LLMProvider } from '../types/app';
import type { CodeEditorDiffInfo } from '../components/code-editor/types/types';
import { isPanelId, type WorkspacePanel, type WorkspaceTab } from '../types/workspace';

/**
 * Per-project VSCode-like workspace tabs: chat sessions, live shells and
 * opened files become persistent, closable tabs; Files/Git/Tasks/plugins
 * remain singleton panels sharing the same selection space.
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
  activeId: string | null;
};

type PersistedWorkspaceState = WorkspaceState & { version: 1 };

export type OpenChatTabOptions = {
  provider?: LLMProvider;
  title?: string;
  activate?: boolean;
};

export type OpenShellTabOptions = {
  sessionId?: string | null;
  provider?: LLMProvider;
  title?: string;
};

export type UseWorkspaceTabsResult = {
  tabs: WorkspaceTab[];
  activeId: string | null;
  /** Resolved active workspace tab, or null when a panel (or nothing) is active. */
  activeTab: WorkspaceTab | null;
  /** Active panel id, or null when a workspace tab is active. */
  activePanel: WorkspacePanel | null;
  openChatTab: (sessionId: string | null, opts?: OpenChatTabOptions) => string;
  openShellTab: (opts?: OpenShellTabOptions) => string;
  openFileTab: (path: string, name?: string, diffInfo?: CodeEditorDiffInfo | null) => string;
  setActive: (id: string) => void;
  closeTab: (id: string) => void;
  /** Mutates the pending (sessionId === null) chat tab into a real session. */
  adoptPendingSession: (sessionId: string, provider?: LLMProvider, title?: string) => void;
  findChatTabBySession: (sessionId: string) => WorkspaceTab | undefined;
  /** Closes chat/shell tabs whose session no longer exists. */
  closeTabsForSession: (sessionId: string) => void;
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

function generateShellId(): string {
  return `sh_${generateTabId().slice(4)}`;
}

function fileNameFromPath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  return normalized.split('/').pop() || path;
}

/** Seeds a new project with one pending chat tab so the app opens on chat. */
function seedState(): WorkspaceState {
  const pendingChat: WorkspaceTab = { id: generateTabId(), kind: 'chat', sessionId: null };
  return { tabs: [pendingChat], activeId: pendingChat.id };
}

function isValidTab(value: unknown): value is WorkspaceTab {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const tab = value as Record<string, unknown>;
  if (typeof tab.id !== 'string' || !tab.id.startsWith('tab_')) {
    return false;
  }
  if (tab.kind === 'chat') {
    return tab.sessionId === null || typeof tab.sessionId === 'string';
  }
  if (tab.kind === 'shell') {
    return typeof tab.shellId === 'string' && (tab.sessionId === null || typeof tab.sessionId === 'string');
  }
  if (tab.kind === 'file') {
    return typeof tab.path === 'string' && typeof tab.name === 'string';
  }
  return false;
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
    if (tabs.length === 0) {
      return seedState();
    }
    const activeId =
      typeof parsed.activeId === 'string' &&
        (isPanelId(parsed.activeId) || tabs.some((tab) => tab.id === parsed.activeId))
        ? parsed.activeId
        : tabs[0].id;
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

  useEffect(() => {
    if (stateProjectIdRef.current === projectId) {
      return;
    }
    stateProjectIdRef.current = projectId;
    applyState(projectId ? loadState(projectId) : EMPTY_STATE);
  }, [applyState, projectId]);

  useEffect(() => {
    if (projectId && stateProjectIdRef.current === projectId) {
      persistState(projectId, state);
    }
  }, [projectId, state]);

  const openChatTab = useCallback(
    (sessionId: string | null, opts?: OpenChatTabOptions): string => {
      const previous = stateRef.current;
      const activate = opts?.activate ?? true;
      const existing = previous.tabs.find(
        (tab) => tab.kind === 'chat' && tab.sessionId === sessionId,
      );

      if (existing) {
        const tabs =
          opts?.title && existing.kind === 'chat' && existing.title !== opts.title
            ? previous.tabs.map((tab) => (tab.id === existing.id ? { ...tab, title: opts.title } : tab))
            : previous.tabs;
        applyState({ tabs, activeId: activate ? existing.id : previous.activeId });
        return existing.id;
      }

      const tab: WorkspaceTab = {
        id: generateTabId(),
        kind: 'chat',
        sessionId,
        provider: opts?.provider,
        title: opts?.title,
      };
      applyState({
        tabs: [...previous.tabs, tab],
        activeId: activate ? tab.id : previous.activeId,
      });
      return tab.id;
    },
    [applyState],
  );

  const openShellTab = useCallback(
    (opts?: OpenShellTabOptions): string => {
      const previous = stateRef.current;
      const tab: WorkspaceTab = {
        id: generateTabId(),
        kind: 'shell',
        shellId: generateShellId(),
        sessionId: opts?.sessionId ?? null,
        provider: opts?.provider,
        title: opts?.title,
      };
      applyState({ tabs: [...previous.tabs, tab], activeId: tab.id });
      return tab.id;
    },
    [applyState],
  );

  const openFileTab = useCallback(
    (path: string, name?: string, diffInfo: CodeEditorDiffInfo | null = null): string => {
      const previous = stateRef.current;
      const existing = previous.tabs.find((tab) => tab.kind === 'file' && tab.path === path);

      if (existing) {
        // Re-opens refresh the diff (e.g. a newer quick-diff from chat).
        const tabs = previous.tabs.map((tab) =>
          tab.id === existing.id && tab.kind === 'file' ? { ...tab, diffInfo } : tab,
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
      let tabs = previous.tabs.filter((tab) => tab.id !== id);
      let activeId = previous.activeId;
      if (tabs.length === 0) {
        // Closing the last tab falls back to a fresh pending chat tab
        // (chat is the app's home surface).
        const seeded = seedState();
        tabs = seeded.tabs;
        activeId = activeId === id ? seeded.activeId : activeId;
      } else if (activeId === id) {
        // Prefer the left neighbor, then right.
        const neighbor = tabs[index - 1] ?? tabs[index];
        activeId = neighbor.id;
      }
      applyState({ tabs, activeId });
    },
    [applyState],
  );

  const adoptPendingSession = useCallback(
    (sessionId: string, provider?: LLMProvider, title?: string) => {
      const previous = stateRef.current;
      const pending = previous.tabs.find((tab) => tab.kind === 'chat' && tab.sessionId === null);
      if (!pending) {
        return;
      }
      const existing = previous.tabs.find(
        (tab) => tab.kind === 'chat' && tab.sessionId === sessionId,
      );
      if (existing) {
        // Another tab already owns the session: drop the pending tab.
        const tabs = previous.tabs.filter((tab) => tab.id !== pending.id);
        const activeId = previous.activeId === pending.id ? existing.id : previous.activeId;
        applyState({ tabs, activeId });
        return;
      }
      const tabs = previous.tabs.map((tab) =>
        tab.id === pending.id ? { ...tab, sessionId, provider, title } : tab,
      );
      applyState({ ...previous, tabs });
    },
    [applyState],
  );

  const findChatTabBySession = useCallback(
    (sessionId: string) => stateRef.current.tabs.find((tab) => tab.kind === 'chat' && tab.sessionId === sessionId),
    [],
  );

  const closeTabsForSession = useCallback(
    (sessionId: string) => {
      const previous = stateRef.current;
      const removed = previous.tabs.filter(
        (tab) => (tab.kind === 'chat' || tab.kind === 'shell') && tab.sessionId === sessionId,
      );
      if (removed.length === 0) {
        return;
      }
      const removedIds = new Set(removed.map((tab) => tab.id));
      let tabs = previous.tabs.filter((tab) => !removedIds.has(tab.id));
      let activeId = previous.activeId;
      if (tabs.length === 0) {
        const seeded = seedState();
        tabs = seeded.tabs;
        activeId = activeId && removedIds.has(activeId) ? seeded.activeId : activeId;
      } else if (activeId && removedIds.has(activeId)) {
        activeId = tabs[0].id;
      }
      applyState({ tabs, activeId });
    },
    [applyState],
  );

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
    openChatTab,
    openShellTab,
    openFileTab,
    setActive,
    closeTab,
    adoptPendingSession,
    findChatTabBySession,
    closeTabsForSession,
  };
}
