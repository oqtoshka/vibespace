import { useCallback, useEffect, useRef, useState } from 'react';

type UseExpandedDirectoriesResult = {
  expandedDirs: Set<string>;
  toggleDirectory: (path: string) => void;
  expandDirectories: (paths: string[]) => void;
  /** Drops paths (and their descendants) from the set — for directories that
   * no longer exist on disk, so refreshes stop refetching them forever. */
  pruneDirectories: (paths: string[]) => void;
  collapseAll: () => void;
};

const STORAGE_PREFIX = 'vibespace:file-tree:expanded:';

function storageKey(projectId: string | undefined): string | null {
  return projectId ? `${STORAGE_PREFIX}${projectId}` : null;
}

function loadExpanded(projectId: string | undefined): Set<string> {
  const key = storageKey(projectId);
  if (!key) {
    return new Set();
  }
  try {
    const raw = localStorage.getItem(key);
    if (!raw) {
      return new Set();
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((p): p is string => typeof p === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

function persistExpanded(projectId: string | undefined, dirs: Set<string>): void {
  const key = storageKey(projectId);
  if (!key) {
    return;
  }
  try {
    if (dirs.size === 0) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, JSON.stringify([...dirs]));
    }
  } catch {
    // Keep runtime state even when persistence fails.
  }
}

/**
 * Tracks which directories are expanded, persisted per project so the tree
 * keeps its shape across remounts, tab switches, and reloads. The set is keyed
 * by `projectId`; switching projects swaps in that project's saved state.
 */
export function useExpandedDirectories(projectId?: string): UseExpandedDirectoriesResult {
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => loadExpanded(projectId));

  // Reload the saved set when the project changes. Guarded so we don't clobber
  // the freshly-loaded set with the previous project's persistence effect.
  const projectIdRef = useRef(projectId);
  useEffect(() => {
    if (projectIdRef.current !== projectId) {
      projectIdRef.current = projectId;
      setExpandedDirs(loadExpanded(projectId));
    }
  }, [projectId]);

  // Persist on every change (for the current project only).
  useEffect(() => {
    if (projectIdRef.current === projectId) {
      persistExpanded(projectId, expandedDirs);
    }
  }, [expandedDirs, projectId]);

  const toggleDirectory = useCallback((path: string) => {
    setExpandedDirs((previous) => {
      const next = new Set(previous);

      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }

      return next;
    });
  }, []);

  const expandDirectories = useCallback((paths: string[]) => {
    if (paths.length === 0) {
      return;
    }

    setExpandedDirs((previous) => {
      const next = new Set(previous);
      paths.forEach((path) => next.add(path));
      return next;
    });
  }, []);

  const pruneDirectories = useCallback((paths: string[]) => {
    if (paths.length === 0) {
      return;
    }
    setExpandedDirs((previous) => {
      const next = new Set(
        [...previous].filter(
          (dir) => !paths.some((path) => dir === path || dir.startsWith(`${path}/`)),
        ),
      );
      return next.size === previous.size ? previous : next;
    });
  }, []);

  const collapseAll = useCallback(() => {
    setExpandedDirs(new Set());
  }, []);

  return {
    expandedDirs,
    toggleDirectory,
    expandDirectories,
    pruneDirectories,
    collapseAll,
  };
}
