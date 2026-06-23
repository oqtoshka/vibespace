import type { Project, ProjectSession } from '../../../types/app';
import type { WorkspacePanel, WorkspaceTab } from '../../../types/workspace';
import type { CodeEditorDiffInfo } from '../../code-editor/types/types';
import type { SessionNavigationOptions } from '../../chat/types/types';
import type { SessionView } from '../../../hooks/useSessionPane';
import type { MarkSessionProcessing, MarkSessionIdle, SessionActivityMap } from '../../../hooks/useSessionProtection';

/**
 * Workspace tab surface threaded from AppContent (which owns useWorkspaceTabs)
 * into MainContent. Files only — chat/terminal live in the session pane.
 */
export type WorkspaceApi = {
  tabs: WorkspaceTab[];
  activeId: string | null;
  activeTab: WorkspaceTab | null;
  activePanel: WorkspacePanel | null;
  activateTab: (id: string) => void;
  closeTab: (id: string) => void;
  openFileTab: (path: string, name?: string, diffInfo?: CodeEditorDiffInfo | null) => string;
};

export type SessionLifecycleHandler = (sessionId?: string | null) => void;

export type TaskMasterTask = {
  id: string | number;
  title?: string;
  description?: string;
  status?: string;
  priority?: string;
  details?: string;
  testStrategy?: string;
  parentId?: string | number;
  dependencies?: Array<string | number>;
  subtasks?: TaskMasterTask[];
  [key: string]: unknown;
};

export type TaskReference = {
  id: string | number;
  title?: string;
  [key: string]: unknown;
};

export type TaskSelection = TaskMasterTask | TaskReference;

export type PrdFile = {
  name: string;
  content?: string;
  isExisting?: boolean;
  [key: string]: unknown;
};

export type MainContentProps = {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  workspace: WorkspaceApi;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  isMobile: boolean;
  onMenuClick: () => void;
  isLoading: boolean;
  onInputFocusChange: (focused: boolean) => void;
  onSessionProcessing: MarkSessionProcessing;
  onSessionIdle: MarkSessionIdle;
  processingSessions: SessionActivityMap;
  onNavigateToSession: (targetSessionId: string, options?: SessionNavigationOptions) => void;
  onShowSettings: () => void;
  externalMessageUpdate: number;
  newSessionTrigger: number;
  /** Current session's view (chat ⇄ terminal), resolved by AppContent. */
  sessionView: SessionView;
  onSessionViewChange: (view: SessionView) => void;
  sessionPaneOpen: boolean;
  onOpenSessionPane: () => void;
  onCloseSessionPane: () => void;
  sessionPaneWidth: number | null;
  onSessionPaneWidthChange: (width: number) => void;
};

export type MainContentHeaderProps = {
  workspace: WorkspaceApi;
  selectedProject: Project;
  selectedSession: ProjectSession | null;
  shouldShowTasksTab: boolean;
  isMobile: boolean;
  onMenuClick: () => void;
  onCloseTab: (id: string) => void;
  sessionPaneOpen: boolean;
  onToggleSessionPane: () => void;
};

export type MainContentStateViewProps = {
  mode: 'loading' | 'empty';
  isMobile: boolean;
  onMenuClick: () => void;
};

export type MobileMenuButtonProps = {
  onMenuClick: () => void;
  compact?: boolean;
};

export type TaskMasterPanelProps = {
  isVisible: boolean;
};
