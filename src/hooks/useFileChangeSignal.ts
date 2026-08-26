import { useCallback, useEffect, useRef } from 'react';

import { useWebSocket, useWebSocketEvent, type ServerEvent } from '../contexts/WebSocketContext';

import { useProjectFilesWatch, type FileChange, type FileChangeType } from './useProjectFilesWatch';

/**
 * Fires `onChange` whenever one file is (re)written or removed on disk.
 *
 * Two feeds, because neither alone covers every open file:
 * - the project watcher (`files_changed`), which the file tree already keeps
 *   running, but which skips ignored dirs (`dist/`, `build/`), stops at a depth
 *   limit and never sees additional file roots;
 * - a per-file stat poll (`files.watch` → `file_changed`) the server runs for
 *   exactly this path under the file API's own containment rules.
 *
 * A write usually shows up on both within a second; the second report inside
 * DEDUPE_WINDOW_MS is dropped so a viewer reloads once, not twice.
 */

const DEDUPE_WINDOW_MS = 750;

export function useFileChangeSignal(
  projectId: string | undefined,
  filePath: string | null | undefined,
  onChange: (type: FileChangeType) => void,
): void {
  const { sendMessage, isConnected } = useWebSocket();
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const lastFiredRef = useRef<{ at: number; type: FileChangeType } | null>(null);

  const fire = useCallback((type: FileChangeType) => {
    const now = Date.now();
    const last = lastFiredRef.current;
    if (last && last.type === type && now - last.at < DEDUPE_WINDOW_MS) {
      return;
    }
    lastFiredRef.current = { at: now, type };
    onChangeRef.current(type);
  }, []);

  const handleProjectChanges = useCallback(
    (changes: FileChange[]) => {
      if (!filePath) return;
      const mine = changes.find((change) => change.path === filePath);
      if (mine && mine.type !== 'addDir' && mine.type !== 'unlinkDir') {
        fire(mine.type);
      }
    },
    [filePath, fire],
  );
  useProjectFilesWatch(projectId, handleProjectChanges);

  useEffect(() => {
    if (!projectId || !filePath || !isConnected) {
      return;
    }
    sendMessage({ type: 'files.watch', projectId, path: filePath });
    return () => {
      sendMessage({ type: 'files.unwatch', projectId, path: filePath });
    };
  }, [projectId, filePath, isConnected, sendMessage]);

  useWebSocketEvent((event: ServerEvent) => {
    if (event.kind !== 'file_changed' || event.projectId !== projectId || event.path !== filePath) {
      return;
    }
    const type = event.type as FileChangeType | undefined;
    if (type === 'add' || type === 'change' || type === 'unlink') {
      fire(type);
    }
  });
}
