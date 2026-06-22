import { useEffect, useRef } from 'react';
import { useWebSocket, useWebSocketEvent, type ServerEvent } from '../contexts/WebSocketContext';

export type FileChangeType = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';

export type FileChange = { path: string; type: FileChangeType };

/**
 * Subscribes to server-pushed filesystem changes for a project and invokes
 * `onChanges` whenever the watcher reports activity. The subscription is sent
 * over the chat websocket; it is re-established automatically after a reconnect
 * (the socket flipping back to connected re-runs the subscribe effect) and torn
 * down when the project changes or the component unmounts.
 *
 * `onChanges` is read through a ref so callers can pass an inline closure
 * without churning the subscription.
 */
export function useProjectFilesWatch(
  projectId: string | undefined,
  onChanges: (changes: FileChange[]) => void,
): void {
  const { sendMessage, isConnected } = useWebSocket();

  const onChangesRef = useRef(onChanges);
  onChangesRef.current = onChanges;

  useEffect(() => {
    if (!projectId || !isConnected) {
      return;
    }

    sendMessage({ type: 'files.subscribe', projectId });

    return () => {
      sendMessage({ type: 'files.unsubscribe', projectId });
    };
  }, [projectId, isConnected, sendMessage]);

  useWebSocketEvent((event: ServerEvent) => {
    if (event.kind !== 'files_changed' || event.projectId !== projectId) {
      return;
    }
    const changes = Array.isArray(event.changes) ? (event.changes as FileChange[]) : [];
    if (changes.length > 0) {
      onChangesRef.current(changes);
    }
  });
}
