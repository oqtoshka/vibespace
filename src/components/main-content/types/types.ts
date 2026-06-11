import type { Project, ProjectSession } from '../../../types/app';
import type { WorkspacePanel, WorkspaceTab } from '../../../types/workspace';
import type { OpenShellTabOptions } from '../../../hooks/useWorkspaceTabs';
import type { CodeEditorDiffInfo } from '../../code-editor/types/types';
import type { SessionNavigationOptions } from '../../chat/types/types';

/**
 * Workspace tab surface threaded from AppContent (which owns
 * useWorkspaceTabs + the tab↔session coordination) into MainContent.
 * `activateTab` also drives session selection for chat tabs.
 */
export type WorkspaceApi = {
  tabs: WorkspaceTab[];
  activeId: string | null;
  activeTab: WorkspaceTab | null;
  activePanel: WorkspacePanel | null;
  activateTab: (id: string) => void;
  closeTab: (id: string) => void;
  openShellTab: (opts?: OpenShellTabOptions) => string;
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
  // The file tree lives in the main sidebar; these reflect/drive its view.
  filesSidebarActive: boolean;
  onShowFilesSidebar: () => void;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  latestMessage: unknown;
  isMobile: boolean;
  onMenuClick: () => void;
  isLoading: boolean;
  onInputFocusChange: (focused: boolean) => void;
  onSessionActive: SessionLifecycleHandler;
  onSessionInactive: SessionLifecycleHandler;
  onSessionProcessing: SessionLifecycleHandler;
  onSessionNotProcessing: SessionLifecycleHandler;
  processingSessions: Set<string>;
  onNavigateToSession: (targetSessionId: string, options?: SessionNavigationOptions) => void;
  onShowSettings: () => void;
  externalMessageUpdate: number;
  newSessionTrigger: number;
};

export type MainContentHeaderProps = {
  workspace: WorkspaceApi;
  selectedProject: Project;
  selectedSession: ProjectSession | null;
  shouldShowTasksTab: boolean;
  isMobile: boolean;
  onMenuClick: () => void;
  onCloseTab: (id: string) => void;
  onNewShell: () => void;
  filesSidebarActive: boolean;
  onShowFilesSidebar: () => void;
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
