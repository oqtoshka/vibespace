import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../../utils/api';
import type { Project } from '../../../types/app';
import type { FileTreeNode } from '../types/types';

type UseFileTreeDataResult = {
  files: FileTreeNode[];
  loading: boolean;
  refreshFiles: () => void;
  /** Fetches children for a directory whose subtree hasn't been loaded yet
   * (`children === undefined`). No-ops while a fetch is already in flight. */
  loadDirectory: (dirPath: string) => void;
  /** Loads the whole deep tree once (search needs it); idempotent until the
   * next refresh or project switch. */
  ensureFullTree: () => void;
  isFullTreeLoading: boolean;
};

// Each fetch returns the directory's children plus one prefetched level below
// them, so expanding an already-visible directory is instant and only every
// other expand hits the network.
const LAZY_FETCH_DEPTH = 1;

/** Immutably replaces the children of the node at `dirPath`. Returns the tree
 * unchanged when the path is no longer present (e.g. deleted between fetches). */
function withChildrenAt(
  nodes: FileTreeNode[],
  dirPath: string,
  children: FileTreeNode[],
): FileTreeNode[] {
  return nodes.map((node) => {
    if (node.type !== 'directory') {
      return node;
    }
    if (node.path === dirPath) {
      return { ...node, children };
    }
    if (node.children && dirPath.startsWith(`${node.path}/`)) {
      return { ...node, children: withChildrenAt(node.children, dirPath, children) };
    }
    return node;
  });
}

function isAbortError(error: unknown): boolean {
  return (error as { name?: string })?.name === 'AbortError';
}

export function useFileTreeData(
  selectedProject: Project | null,
  expandedDirs: Set<string>,
  /** Called with a directory path the server reported missing (404) — the
   * persisted expansion state references a directory that was deleted on
   * disk. The owner prunes it so refreshes stop refetching it forever. */
  onDirectoryMissing?: (dirPath: string) => void,
): UseFileTreeDataResult {
  const [files, setFiles] = useState<FileTreeNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [isFullTreeLoading, setIsFullTreeLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  // Read through a ref so refreshes see the current expansion state without
  // re-running the fetch effect on every expand/collapse.
  const expandedDirsRef = useRef(expandedDirs);
  expandedDirsRef.current = expandedDirs;
  // Directories with an in-flight children fetch (dedupes repeated expands).
  const pendingDirsRef = useRef(new Set<string>());
  const fullTreeRequestedRef = useRef(false);
  // Ref so the fetch effect doesn't re-run when the owner re-creates the
  // callback; missing-dir reports always reach the latest handler.
  const onDirectoryMissingRef = useRef(onDirectoryMissing);
  onDirectoryMissingRef.current = onDirectoryMissing;

  // File-tree requests use the DB projectId; the backend resolves it to the
  // project's absolute path through the projects table.
  const projectId = selectedProject?.projectId;

  const refreshFiles = useCallback(() => {
    setRefreshKey((prev) => prev + 1);
  }, []);

  useEffect(() => {
    fullTreeRequestedRef.current = false;
    pendingDirsRef.current = new Set();

    if (!projectId) {
      setFiles([]);
      setLoading(false);
      return;
    }

    // Abort previous request
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    // Track mount state so aborted or late responses do not enqueue stale state updates.
    let isActive = true;

    const fetchJson = async (options: {
      dir?: string;
      depth?: number;
    }): Promise<FileTreeNode[] | null> => {
      const response = await api.getFiles(projectId, { ...options, signal: controller.signal });
      if (!response.ok) {
        // A 404 for a subtree means the persisted expanded directory was
        // deleted on disk — report it for pruning instead of erroring on
        // every refresh from now on.
        if (response.status === 404 && options.dir) {
          onDirectoryMissingRef.current?.(options.dir);
          return null;
        }
        console.error('File fetch failed:', response.status, await response.text());
        return null;
      }
      return (await response.json()) as FileTreeNode[];
    };

    const fetchTree = async () => {
      setLoading(true);
      try {
        // Refetch the root plus every expanded directory so a refresh doesn't
        // collapse what the user already drilled into. Shallow-first ordering
        // lets each merge find its parent already in place.
        const expanded = [...expandedDirsRef.current].sort((a, b) => a.length - b.length);
        const [rootData, ...dirData] = await Promise.all([
          fetchJson({ depth: LAZY_FETCH_DEPTH }),
          ...expanded.map((dir) =>
            fetchJson({ dir, depth: LAZY_FETCH_DEPTH }).catch((error) => {
              if (!isAbortError(error)) {
                console.error('Error refreshing directory:', dir, error);
              }
              return null;
            }),
          ),
        ]);

        if (!isActive) {
          return;
        }
        if (!rootData) {
          setFiles([]);
          return;
        }

        let tree = rootData;
        expanded.forEach((dir, index) => {
          const children = dirData[index];
          if (children) {
            tree = withChildrenAt(tree, dir, children);
          }
        });
        setFiles(tree);
      } catch (error) {
        if (isAbortError(error)) {
          return;
        }
        console.error('Error fetching files:', error);
        if (isActive) {
          setFiles([]);
        }
      } finally {
        if (isActive) {
          setLoading(false);
        }
      }
    };

    void fetchTree();

    return () => {
      isActive = false;
      controller.abort();
    };
  }, [projectId, refreshKey]);

  const loadDirectory = useCallback(
    (dirPath: string) => {
      if (!projectId || pendingDirsRef.current.has(dirPath)) {
        return;
      }
      pendingDirsRef.current.add(dirPath);
      const signal = abortControllerRef.current?.signal;

      void (async () => {
        try {
          const response = await api.getFiles(projectId, {
            dir: dirPath,
            depth: LAZY_FETCH_DEPTH,
            signal,
          });
          if (signal?.aborted) {
            return;
          }
          if (response.status === 404) {
            onDirectoryMissingRef.current?.(dirPath);
          }
          const children = response.ok ? ((await response.json()) as FileTreeNode[]) : [];
          setFiles((prev) => withChildrenAt(prev, dirPath, children));
        } catch (error) {
          if (isAbortError(error)) {
            return;
          }
          console.error('Error loading directory:', dirPath, error);
          // Mark as loaded-empty so the row doesn't show a spinner forever.
          setFiles((prev) => withChildrenAt(prev, dirPath, []));
        } finally {
          pendingDirsRef.current.delete(dirPath);
        }
      })();
    },
    [projectId],
  );

  const ensureFullTree = useCallback(() => {
    if (!projectId || fullTreeRequestedRef.current) {
      return;
    }
    fullTreeRequestedRef.current = true;
    const signal = abortControllerRef.current?.signal;
    setIsFullTreeLoading(true);

    void (async () => {
      try {
        const response = await api.getFiles(projectId, { signal });
        if (!response.ok) {
          fullTreeRequestedRef.current = false;
          console.error('Full tree fetch failed:', response.status, await response.text());
          return;
        }
        const data = (await response.json()) as FileTreeNode[];
        if (signal?.aborted) {
          return;
        }
        setFiles(data);
      } catch (error) {
        fullTreeRequestedRef.current = false;
        if (!isAbortError(error)) {
          console.error('Error fetching full file tree:', error);
        }
      } finally {
        setIsFullTreeLoading(false);
      }
    })();
  }, [projectId]);

  return {
    files,
    loading,
    refreshFiles,
    loadDirectory,
    ensureFullTree,
    isFullTreeLoading,
  };
}
