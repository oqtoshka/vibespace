import { ChevronRight, CornerLeftUp, File as FileIcon, Folder, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../../../utils/api';

type BreadcrumbEntry = {
  name: string;
  type: 'file' | 'directory';
  path: string;
};

type CodeEditorBreadcrumbProps = {
  /** Absolute path of the currently open file. */
  filePath: string;
  /** Absolute project root; used to trim the breadcrumb to project-relative. */
  projectPath?: string;
  /** DB project id, required to list sibling directories. */
  projectId?: string;
  /** Opens another in-project file in the same tab. */
  onFileOpen?: ((filePath: string) => void) | null;
};

/** Join absolute path parts with '/', collapsing the leading empty segment. */
function joinAbs(parts: string[]): string {
  const joined = parts.join('/');
  return joined === '' ? '/' : joined;
}

export default function CodeEditorBreadcrumb({
  filePath,
  projectPath,
  projectId,
  onFileOpen,
}: CodeEditorBreadcrumbProps) {
  // Split the absolute path; `absParts[0]` is '' from the leading slash.
  const absParts = useMemo(() => filePath.split('/'), [filePath]);

  // Index into `absParts` where the displayed (project-relative) crumbs start.
  const startIdx = useMemo(() => {
    if (projectPath) {
      const root = projectPath.replace(/\/+$/, '');
      if (filePath === root || filePath.startsWith(`${root}/`)) {
        return root.split('/').length;
      }
    }
    // No project root match: show the full absolute path minus the leading ''.
    return 1;
  }, [filePath, projectPath]);

  const segments = useMemo(
    () =>
      absParts.slice(startIdx).map((name, i) => {
        const absIndex = startIdx + i;
        return {
          name,
          // Absolute path of this crumb itself.
          path: joinAbs(absParts.slice(0, absIndex + 1)),
          // Absolute path of the folder that contains it (its siblings live here).
          parentDir: joinAbs(absParts.slice(0, absIndex)),
        };
      }),
    [absParts, startIdx],
  );

  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [browseDir, setBrowseDir] = useState<string | null>(null);
  const [entries, setEntries] = useState<BreadcrumbEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const canBrowse = Boolean(projectId);

  const closeMenu = useCallback(() => {
    setOpenIndex(null);
    setBrowseDir(null);
    setEntries([]);
    setError(null);
  }, []);

  // Close on outside click / Escape while a crumb menu is open.
  useEffect(() => {
    if (openIndex === null) return undefined;
    const onPointerDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        closeMenu();
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeMenu();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [openIndex, closeMenu]);

  // Keep the open (current) file in view as the path grows.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [filePath]);

  // Fetch the directory whenever the active browse dir changes.
  useEffect(() => {
    if (browseDir === null || !projectId) return undefined;
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await api.getFiles(projectId, {
          dir: browseDir,
          depth: 0,
          meta: 0,
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: BreadcrumbEntry[] = await res.json();
        if (!cancelled) setEntries(Array.isArray(data) ? data : []);
      } catch (e) {
        if (!cancelled && (e as Error).name !== 'AbortError') {
          setError('Failed to load');
          setEntries([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [browseDir, projectId]);

  const toggleSegment = (index: number, parentDir: string) => {
    if (openIndex === index) {
      closeMenu();
      return;
    }
    setOpenIndex(index);
    setBrowseDir(parentDir);
  };

  const handleEntryClick = (entry: BreadcrumbEntry) => {
    if (entry.type === 'directory') {
      setBrowseDir(entry.path);
      return;
    }
    onFileOpen?.(entry.path);
    closeMenu();
  };

  if (segments.length === 0) {
    return <p className="truncate text-xs text-gray-500 dark:text-gray-400">{filePath}</p>;
  }

  return (
    <div ref={containerRef} className="relative min-w-0">
      <div
        ref={scrollRef}
        className="flex items-center overflow-x-auto whitespace-nowrap text-xs text-gray-500 scrollbar-hide dark:text-gray-400"
      >
        {segments.map((segment, index) => {
          const isLast = index === segments.length - 1;
          const isOpen = openIndex === index;
          return (
            <div key={segment.path} className="flex shrink-0 items-center">
              {index > 0 && <ChevronRight className="h-3 w-3 shrink-0 opacity-50" />}
              <button
                type="button"
                disabled={!canBrowse}
                onClick={() => toggleSegment(index, segment.parentDir)}
                className={`rounded px-1 py-0.5 transition-colors ${
                  canBrowse ? 'hover:bg-gray-100 hover:text-gray-900 dark:hover:bg-gray-800 dark:hover:text-white' : ''
                } ${isOpen ? 'bg-gray-100 text-gray-900 dark:bg-gray-800 dark:text-white' : ''} ${
                  isLast ? 'font-medium text-gray-700 dark:text-gray-300' : ''
                }`}
              >
                {segment.name}
              </button>
            </div>
          );
        })}
      </div>

      {openIndex !== null && (
        <BreadcrumbMenu
          loading={loading}
          error={error}
          entries={entries}
          activePath={segments[openIndex]?.path}
          canGoUp={browseDir !== segments[openIndex]?.parentDir}
          onGoBack={() => setBrowseDir(segments[openIndex]?.parentDir ?? null)}
          onEntryClick={handleEntryClick}
        />
      )}
    </div>
  );
}

type BreadcrumbMenuProps = {
  loading: boolean;
  error: string | null;
  entries: BreadcrumbEntry[];
  activePath?: string;
  canGoUp: boolean;
  onGoBack: () => void;
  onEntryClick: (entry: BreadcrumbEntry) => void;
};

function BreadcrumbMenu({
  loading,
  error,
  entries,
  activePath,
  canGoUp,
  onGoBack,
  onEntryClick,
}: BreadcrumbMenuProps) {
  return (
    <div className="absolute left-0 top-full z-[10000] mt-1 max-h-72 w-64 max-w-[80vw] overflow-y-auto rounded-lg border border-border bg-popover py-1 shadow-lg animate-in fade-in-0 zoom-in-95">
      {canGoUp && (
        <button
          type="button"
          onClick={onGoBack}
          className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-gray-500 hover:bg-accent dark:text-gray-400"
        >
          <CornerLeftUp className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">Back</span>
        </button>
      )}
      {loading && (
        <div className="flex items-center gap-2 px-2.5 py-2 text-xs text-gray-500 dark:text-gray-400">
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
          Loading…
        </div>
      )}
      {error && !loading && (
        <div className="px-2.5 py-2 text-xs text-red-600 dark:text-red-400">{error}</div>
      )}
      {!loading && !error && entries.length === 0 && (
        <div className="px-2.5 py-2 text-xs text-gray-500 dark:text-gray-400">Empty</div>
      )}
      {!loading &&
        !error &&
        entries.map((entry) => {
          const isActive = entry.path === activePath;
          return (
            <button
              key={entry.path}
              type="button"
              onClick={() => onEntryClick(entry)}
              className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-accent ${
                isActive
                  ? 'font-medium text-gray-900 dark:text-white'
                  : 'text-gray-700 dark:text-gray-300'
              }`}
            >
              {entry.type === 'directory' ? (
                <Folder className="h-3.5 w-3.5 shrink-0 text-blue-500 dark:text-blue-400" />
              ) : (
                <FileIcon className="h-3.5 w-3.5 shrink-0 text-gray-400" />
              )}
              <span className="truncate">{entry.name}</span>
              {entry.type === 'directory' && (
                <ChevronRight className="ml-auto h-3.5 w-3.5 shrink-0 opacity-40" />
              )}
            </button>
          );
        })}
    </div>
  );
}
