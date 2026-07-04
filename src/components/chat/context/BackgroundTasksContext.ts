import { createContext, useContext } from 'react';
import type { BackgroundTask } from '../hooks/useBackgroundTasks';

/**
 * Lets deep-in-the-tree tool cards (BashCommandDisplay) reach the session's
 * background-task state and controls without prop-drilling through the whole
 * message-render stack. Provided at the ChatInterface level.
 */
export type BackgroundTasksContextValue = {
  /** Derived + server-reconciled tasks, keyed by task id. */
  tasksById: Map<string, BackgroundTask>;
  /** Cancel a running background job (no-op when the provider can't). */
  cancelTask: (taskId: string) => void;
  /** Whether cancellation is supported for this session's provider. */
  canCancel: boolean;
};

const BackgroundTasksContext = createContext<BackgroundTasksContextValue | null>(null);

export const BackgroundTasksProvider = BackgroundTasksContext.Provider;

export function useBackgroundTasksContext(): BackgroundTasksContextValue | null {
  return useContext(BackgroundTasksContext);
}
