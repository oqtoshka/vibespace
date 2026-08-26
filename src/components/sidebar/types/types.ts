import type { LoadingProgress, Project, ProjectSession, LLMProvider } from '../../../types/app';

export type ProjectSortOrder = 'name' | 'date';
// 'projects' is the regular sessions list (search unifies name + content
// matches); 'archived' shows the archive. The old 'conversations' mode was
// folded into the unified search.
export type SidebarSearchMode = 'projects' | 'conversations' | 'archived';
// Top-level sidebar view: the sessions/projects list or the project file tree.
export type SidebarView = 'sessions' | 'files';
// How the Projects tab lays out its content: the classic project-grouped tree,
// or a flat list of every session ordered by recent activity.
export type ProjectViewMode = 'grouped' | 'activity';
export type ArchivedProjectListItem = Project & { isArchived: true };

export type SessionWithProvider = ProjectSession & {
  __provider: LLMProvider;
};

// A single row in the activity (flat) view: a session plus the context the
// row needs to render and the attention flags used for ordering.
export type ActivitySessionItem = {
  session: SessionWithProvider;
  project: Project;
  isUnread: boolean;
  isRunning: boolean;
};

export type ArchivedSessionListItem = {
  sessionId: string;
  provider: LLMProvider;
  projectId: string | null;
  projectPath: string | null;
  projectDisplayName: string;
  sessionTitle: string;
  createdAt: string | null;
  updatedAt: string | null;
  lastActivity: string | null;
  isProjectArchived: boolean;
};

export type RecentConversationListItem = Pick<
  ArchivedSessionListItem,
  'sessionId' | 'provider' | 'projectId' | 'projectDisplayName' | 'sessionTitle' | 'lastActivity'
>;

export type DeleteProjectConfirmation = {
  project: Project;
  sessionCount: number;
};

// Delete confirmation payload used by sidebar UX. `projectId`/`provider` are
// kept for wiring compatibility, while API deletion now keys only by sessionId.
export type SessionDeleteConfirmation = {
  projectId: string | null;
  sessionId: string;
  sessionTitle: string;
  provider: LLMProvider;
  isArchived: boolean;
  /** Started private — shown in the deletion dialog. */
  isPrivate: boolean;
};

export type SidebarProps = {
  projects: Project[];
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  onProjectSelect: (project: Project) => void;
  onSessionSelect: (session: ProjectSession) => void;
  onNewSession: (project: Project) => void;
  onSessionDelete?: (sessionId: string) => void;
  onLoadMoreSessions?: (projectId: string) => Promise<void> | void;
  // `projectId` is the DB identifier; the sidebar hands it back to the parent
  // when the delete flow completes.
  onProjectDelete?: (projectId: string) => void;
  // Sessions currently mid-run; used by the activity view to tell "stopped"
  // sessions (done, may need your attention) from ones still working.
  processingSessions?: Set<string>;
  isLoading: boolean;
  loadingProgress: LoadingProgress | null;
  onRefresh: () => Promise<void> | void;
  onShowSettings: () => void;
  showSettings: boolean;
  settingsInitialTab: string;
  onCloseSettings: () => void;
  isMobile: boolean;
  // Sessions list vs project file tree (controlled by AppContent so the
  // header's files button and the command palette can switch it).
  view: SidebarView;
  onViewChange: (view: SidebarView) => void;
  // Opens a file from the sidebar file tree as a workspace tab.
  onFileOpen: (filePath: string) => void;
};

export type SessionViewModel = {
  isCursorSession: boolean;
  isCodexSession: boolean;
  isOpenCodeSession: boolean;
  isActive: boolean;
  sessionName: string;
  sessionTime: string;
  messageCount: number;
};

export type MCPServerStatus = {
  hasMCPServer?: boolean;
  isConfigured?: boolean;
} | null;

// Retained as `name` for backwards compatibility with existing settings
// consumers; the value is populated from `projectId` by normalizeProjectForSettings.
export type SettingsProject = {
  name: string;
  displayName: string;
  fullPath: string;
  path?: string;
};
