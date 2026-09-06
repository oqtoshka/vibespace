import { type ReactNode } from 'react';
import { Archive, Folder, MessageSquare, RotateCcw, Search, Trash2 } from 'lucide-react';
import type { TFunction } from 'i18next';

import { ScrollArea } from '../../../../shared/view/ui';
import type { Project } from '../../../../types/app';
import type { ReleaseInfo } from '../../../../shared/types';
import type { ConversationSearchResults, SearchProgress } from '../../hooks/useSidebarController';
import type { ArchivedProjectListItem, ArchivedSessionListItem, RecentConversationListItem, SidebarSearchMode, SidebarView } from '../../types/types';
import LLMProviderLogo from '../../../llm-provider-logo/LLMProviderLogo';
import { formatCompactAge, getAllSessions } from '../../utils/utils';

import SidebarFooter from './SidebarFooter';
import SidebarHeader from './SidebarHeader';
import SidebarProjectList, { type SidebarProjectListProps } from './SidebarProjectList';
import SidebarRecentConversations from './SidebarRecentConversations';
import SidebarSessionAvatar from './SidebarSessionAvatar';

function HighlightedSnippet({ snippet, highlights }: { snippet: string; highlights: { start: number; end: number }[] }) {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const h of highlights) {
    if (h.start > cursor) {
      parts.push(snippet.slice(cursor, h.start));
    }
    parts.push(
      <mark key={h.start} className="rounded-sm bg-yellow-200 px-0.5 text-foreground dark:bg-yellow-800">
        {snippet.slice(h.start, h.end)}
      </mark>
    );
    cursor = h.end;
  }
  if (cursor < snippet.length) {
    parts.push(snippet.slice(cursor));
  }
  return (
    <span className="min-w-0 flex-1 break-words text-xs leading-relaxed text-muted-foreground">
      {parts}
    </span>
  );
}

type ArchivedSessionGroup = {
  key: string;
  projectId: string | null;
  projectDisplayName: string;
  projectPath: string | null;
  isProjectArchived: boolean;
  sessions: ArchivedSessionListItem[];
  latestActivity: string | null;
};

/**
 * Groups archived sessions by project metadata so the archive view preserves
 * the same mental model as the active sidebar: projects first, then sessions.
 */
function groupArchivedSessionsByProject(sessions: ArchivedSessionListItem[]): ArchivedSessionGroup[] {
  const groups = new Map<string, ArchivedSessionGroup>();

  for (const session of sessions) {
    const key = session.projectId ?? session.projectPath ?? `session:${session.sessionId}`;
    const existingGroup = groups.get(key);

    if (existingGroup) {
      existingGroup.sessions.push(session);
      if (!existingGroup.latestActivity || (session.lastActivity && session.lastActivity > existingGroup.latestActivity)) {
        existingGroup.latestActivity = session.lastActivity;
      }
      continue;
    }

    groups.set(key, {
      key,
      projectId: session.projectId,
      projectDisplayName: session.projectDisplayName,
      projectPath: session.projectPath,
      isProjectArchived: session.isProjectArchived,
      sessions: [session],
      latestActivity: session.lastActivity,
    });
  }

  return [...groups.values()].sort((groupA, groupB) => {
    const a = groupA.latestActivity ?? '';
    const b = groupB.latestActivity ?? '';
    return b.localeCompare(a);
  });
}

type SidebarContentProps = {
  isPWA: boolean;
  isMobile: boolean;
  isLoading: boolean;
  projects: Project[];
  archivedProjects: ArchivedProjectListItem[];
  archivedSessions: ArchivedSessionListItem[];
  archivedSessionsCount: number;
  isArchivedSessionsLoading: boolean;
  recentConversations: RecentConversationListItem[];
  recentConversationsTotal: number;
  recentConversationsHasMore: boolean;
  isRecentConversationsLoading: boolean;
  isLoadingMoreRecentConversations: boolean;
  recentConversationsError: boolean;
  searchFilter: string;
  onSearchFilterChange: (value: string) => void;
  onClearSearchFilter: () => void;
  searchMode: SidebarSearchMode;
  onSearchModeChange: (mode: SidebarSearchMode) => void;
  view: SidebarView;
  onViewChange: (view: SidebarView) => void;
  // Pre-rendered file tree (sidebar files view); null when no project selected.
  fileTree: ReactNode | null;
  conversationResults: ConversationSearchResults | null;
  isSearching: boolean;
  searchProgress: SearchProgress | null;
  onRestoreArchivedProject: (projectId: string) => void;
  onLoadMoreRecentConversations: () => void;
  onRetryRecentConversations: () => void;
  onArchivedSessionClick: (session: ArchivedSessionListItem) => void;
  onRestoreArchivedSession: (sessionId: string) => void;
  onDeleteArchivedSession: (session: ArchivedSessionListItem) => void;
  // Conversation result clicks pass back the DB projectId (or null when the
  // server couldn't resolve it). Consumers must handle the null case.
  onConversationResultClick: (projectId: string | null, sessionId: string, provider: string, messageTimestamp?: string | null, messageSnippet?: string | null) => void;
  onRefresh: () => void;
  isRefreshing: boolean;
  onCreateProject: () => void;
  onCollapseSidebar: () => void;
  updateAvailable: boolean;
  restartRequired: boolean;
  releaseInfo: ReleaseInfo | null;
  latestVersion: string | null;
  onShowVersionModal: () => void;
  onShowSettings: () => void;
  projectListProps: SidebarProjectListProps;
  t: TFunction;
};

export default function SidebarContent({
  isPWA,
  isMobile,
  isLoading,
  projects,
  archivedProjects,
  archivedSessions,
  archivedSessionsCount,
  isArchivedSessionsLoading,
  recentConversations,
  recentConversationsTotal,
  recentConversationsHasMore,
  isRecentConversationsLoading,
  isLoadingMoreRecentConversations,
  recentConversationsError,
  searchFilter,
  onSearchFilterChange,
  onClearSearchFilter,
  searchMode,
  onSearchModeChange,
  view,
  onViewChange,
  fileTree,
  conversationResults,
  isSearching,
  searchProgress,
  onRestoreArchivedProject,
  onLoadMoreRecentConversations,
  onRetryRecentConversations,
  onArchivedSessionClick,
  onRestoreArchivedSession,
  onDeleteArchivedSession,
  onConversationResultClick,
  onRefresh,
  isRefreshing,
  onCreateProject,
  onCollapseSidebar,
  updateAvailable,
  restartRequired,
  releaseInfo,
  latestVersion,
  onShowVersionModal,
  onShowSettings,
  projectListProps,
  t,
}: SidebarContentProps) {
  // Unified search: conversation-content matches stream in below the
  // name-filtered sessions list whenever the query is long enough.
  // The "Recent" tab (upstream's conversation feed) reuses the same
  // streaming search once the query is long enough; with a short query it
  // shows the recent-conversations feed instead.
  const hasSearchQuery = searchFilter.trim().length >= 2;
  const showConversationSection = (searchMode === 'projects' || searchMode === 'conversations') && hasSearchQuery;
  const hasTitleResults = Boolean(
    searchMode === 'conversations' && conversationResults && conversationResults.titleResults.length > 0,
  );
  const hasPartialResults = Boolean(
    conversationResults && (conversationResults.results.length > 0 || hasTitleResults),
  );
  const groupedArchivedSessions = groupArchivedSessionsByProject(archivedSessions);
  const isRenamingOnMobile = isMobile && Boolean(
    projectListProps.editingProject || projectListProps.editingSession,
  );

  return (
    <div
      className="flex h-full w-full flex-col bg-background/80 backdrop-blur-sm md:select-none"
      style={{}}
    >
      <SidebarHeader
        isPWA={isPWA}
        isMobile={isMobile}
        isLoading={isLoading}
        projectsCount={projects.length}
        archivedSessionsCount={archivedSessionsCount}
        isArchivedSessionsLoading={isArchivedSessionsLoading}
        searchFilter={searchFilter}
        onSearchFilterChange={onSearchFilterChange}
        onClearSearchFilter={onClearSearchFilter}
        searchMode={searchMode}
        onSearchModeChange={onSearchModeChange}
        view={view}
        onViewChange={onViewChange}
        onRefresh={onRefresh}
        isRefreshing={isRefreshing}
        onCreateProject={onCreateProject}
        onCollapseSidebar={onCollapseSidebar}
        t={t}
      />

      {view === 'files' ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          {fileTree ?? (
            <div className="px-4 py-12 text-center md:py-8">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-muted md:mb-3">
                <Folder className="h-6 w-6 text-muted-foreground" />
              </div>
              <p className="text-sm text-muted-foreground">
                {t('files.selectProject', 'Select a project to browse its files')}
              </p>
            </div>
          )}
        </div>
      ) : (
      <ScrollArea className="flex-1 overflow-y-auto overscroll-contain md:px-1.5 md:py-2">
        {(() => {
          const conversationSection = showConversationSection ? (
          isSearching && !hasPartialResults ? (
            <div className="px-4 py-12 text-center md:py-8">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-muted md:mb-3">
                <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
              </div>
              <p className="text-sm text-muted-foreground">{t('search.searching')}</p>
              {searchProgress && (
                <p className="mt-1 text-xs text-muted-foreground/60">
                  {t('search.projectsScanned', { count: searchProgress.scannedProjects })}/{searchProgress.totalProjects}
                </p>
              )}
            </div>
          ) : !isSearching && conversationResults && !hasPartialResults ? (
            <div className="px-4 py-12 text-center md:py-8">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-muted md:mb-3">
                <Search className="h-6 w-6 text-muted-foreground" />
              </div>
              <h3 className="mb-2 text-base font-medium text-foreground md:mb-1">{t('search.noResults')}</h3>
              <p className="text-sm text-muted-foreground">{t('search.tryDifferentQuery')}</p>
            </div>
          ) : hasPartialResults && conversationResults ? (
            <div className="space-y-3 px-2" aria-live="polite">
              {hasTitleResults && (
                <section className="space-y-1" aria-labelledby="session-title-results-heading">
                  <div className="flex items-center justify-between px-1 py-0.5">
                    <h3
                      id="session-title-results-heading"
                      className="text-[11px] font-medium text-muted-foreground"
                    >
                      {t('search.sessionTitles', 'Session')}
                    </h3>
                    <span className="text-[10px] tabular-nums text-muted-foreground/70">
                      {conversationResults.titleResults.length}
                    </span>
                  </div>
                  {conversationResults.titleResults.map((session) => {
                    const age = formatCompactAge(session.lastActivity, projectListProps.currentTime);

                    return (
                      <button
                        key={`${session.provider}-${session.sessionId}`}
                        type="button"
                        className="group flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors hover:bg-accent/60"
                        onClick={() => onConversationResultClick(
                          session.projectId,
                          session.sessionId,
                          session.provider,
                        )}
                      >
                        <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md bg-muted/60">
                          <LLMProviderLogo provider={session.provider} className="h-3.5 w-3.5" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            <span className="truncate text-xs font-normal text-foreground">{session.sessionTitle}</span>
                            {age && (
                              <span className="ml-auto flex-shrink-0 text-[11px] text-muted-foreground">{age}</span>
                            )}
                          </span>
                          <span className="mt-0.5 block truncate text-[11px] text-muted-foreground/70">
                            {session.projectDisplayName}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </section>
              )}
              <div className="flex items-center justify-between px-1">
                <p className="text-xs text-muted-foreground">
                  {t('search.matches', { count: conversationResults.totalMatches })}
                </p>
                {isSearching && searchProgress && (
                  <div className="flex items-center gap-1.5">
                    <div className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-muted-foreground/40 border-t-primary" />
                    <p className="text-[10px] text-muted-foreground/60">
                      {searchProgress.scannedProjects}/{searchProgress.totalProjects}
                    </p>
                  </div>
                )}
              </div>
              {isSearching && searchProgress && (
                <div className="mx-1 h-0.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary/60 transition-all duration-300"
                    style={{ width: `${Math.round((searchProgress.scannedProjects / searchProgress.totalProjects) * 100)}%` }}
                  />
                </div>
              )}
              {conversationResults.results.map((projectResult) => (
                <div key={projectResult.projectName} className="space-y-1">
                  <div className="flex items-center gap-1.5 px-1 py-1">
                    <Folder className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
                    <span className="truncate text-xs font-normal text-foreground">
                      {projectResult.projectDisplayName}
                    </span>
                  </div>
                  {projectResult.sessions.map((session) => (
                    <button
                      key={`${projectResult.projectId ?? projectResult.projectName}-${session.sessionId}`}
                      className="w-full rounded-md px-2 py-2 text-left transition-colors hover:bg-accent/50"
                      onClick={() => onConversationResultClick(
                        // Pass the DB projectId (preferred) so the parent can
                        // cross-reference with the loaded projects list.
                        projectResult.projectId,
                        session.sessionId,
                        session.provider || session.matches[0]?.provider || 'claude',
                        session.matches[0]?.timestamp,
                        session.matches[0]?.snippet
                      )}
                    >
                      <div className="mb-1 flex items-center gap-1.5">
                        <MessageSquare className="h-3 w-3 flex-shrink-0 text-primary" />
                        <span className="truncate text-xs font-normal text-foreground">
                          {session.sessionSummary}
                        </span>
                        {session.provider && session.provider !== 'claude' && (
                          <span className="flex-shrink-0 rounded bg-muted px-1 py-0.5 text-[9px] uppercase text-muted-foreground">
                            {session.provider}
                          </span>
                        )}
                      </div>
                      <div className="space-y-1 pl-4">
                        {session.matches.map((match, idx) => (
                          <div key={idx} className="flex items-start gap-1">
                            <span className="mt-0.5 flex-shrink-0 text-[10px] font-normal uppercase text-muted-foreground/60">
                              {match.role === 'user' ? 'U' : 'A'}
                            </span>
                            <HighlightedSnippet
                              snippet={match.snippet}
                              highlights={match.highlights}
                            />
                          </div>
                        ))}
                      </div>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          ) : null
          ) : null;

          return searchMode === 'conversations' ? (
            hasSearchQuery ? (
              conversationSection
            ) : (
              <SidebarRecentConversations
                conversations={recentConversations}
                total={recentConversationsTotal}
                hasMore={recentConversationsHasMore}
                isLoading={isRecentConversationsLoading}
                isLoadingMore={isLoadingMoreRecentConversations}
                hasError={recentConversationsError}
                selectedSession={projectListProps.selectedSession}
                currentTime={projectListProps.currentTime}
                onConversationSelect={onConversationResultClick}
                onLoadMore={onLoadMoreRecentConversations}
                onRetry={onRetryRecentConversations}
                t={t}
              />
            )
          ) : searchMode === 'archived' ? (
          isArchivedSessionsLoading ? (
            <div className="px-4 py-12 text-center md:py-8">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-muted md:mb-3">
                <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
              </div>
              <h3 className="mb-2 text-base font-medium text-foreground md:mb-1">
                {t('archived.loadingTitle', 'Loading archive...')}
              </h3>
              <p className="text-sm text-muted-foreground">
                {t('archived.loadingDescription', 'Fetching hidden workspaces and sessions you can restore later.')}
              </p>
            </div>
          ) : archivedProjects.length === 0 && groupedArchivedSessions.length === 0 ? (
            <div className="px-4 py-12 text-center md:py-8">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-muted md:mb-3">
                <Archive className="h-6 w-6 text-muted-foreground" />
              </div>
              <h3 className="mb-2 text-base font-medium text-foreground md:mb-1">
                {archivedSessionsCount > 0
                  ? t('archived.noMatchingSessions', 'No matching archived items')
                  : t('archived.emptyTitle', 'No archived items')}
              </h3>
              <p className="text-sm text-muted-foreground">
                {archivedSessionsCount > 0
                  ? t('archived.tryDifferentSearch', 'Try a different search term.')
                  : t('archived.emptyDescription', 'Archived workspaces and sessions will appear here when you hide them from the active list.')}
              </p>
            </div>
          ) : (
            <div className="space-y-3 px-2">
              <div className="flex items-center justify-between px-1">
                <p className="text-xs text-muted-foreground">
                  {`${archivedSessionsCount} ${t(
                    archivedSessionsCount === 1 ? 'archived.sessionCountOne' : 'archived.sessionCountOther',
                    archivedSessionsCount === 1 ? 'archived item' : 'archived items',
                  )}`}
                </p>
              </div>
              {archivedProjects.map((project) => {
                const projectSessions = getAllSessions(project);

                return (
                  <div key={project.projectId} className="overflow-hidden rounded-xl border border-border/70 bg-card/60 shadow-sm">
                    <div className="flex items-start justify-between gap-3 border-b border-border/60 px-3 py-2.5">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <Folder className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                          <span className="truncate text-sm font-normal text-foreground">
                            {project.displayName}
                          </span>
                          <span className="inline-flex items-center justify-center rounded-full bg-muted px-1 py-px text-center text-[7px] font-medium uppercase leading-none tracking-[0.02em] text-muted-foreground">
                            {t('archived.projectArchived', 'Project archived')}
                          </span>
                        </div>
                        <p className="mt-1 truncate text-xs text-muted-foreground/70" title={project.fullPath}>
                          {project.fullPath}
                        </p>
                      </div>
                      <button
                        className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-700 transition-colors hover:bg-emerald-100 dark:bg-emerald-900/20 dark:text-emerald-300 dark:hover:bg-emerald-900/30"
                        onClick={() => onRestoreArchivedProject(project.projectId)}
                        title={t('archived.restoreProject', 'Restore workspace')}
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    {projectSessions.length > 0 && (
                      <div className="divide-y divide-border/50">
                        {projectSessions.map((session) => (
                          <button
                            key={String(session.id)}
                            className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-accent/40"
                            onClick={() => onArchivedSessionClick({
                              sessionId: String(session.id),
                              provider: session.__provider,
                              projectId: project.projectId,
                              projectPath: project.fullPath,
                              projectDisplayName: project.displayName,
                              sessionTitle:
                                (typeof session.summary === 'string' && session.summary.trim().length > 0
                                  ? session.summary
                                  : typeof session.name === 'string' && session.name.trim().length > 0
                                    ? session.name
                                    : String(session.id)),
                              createdAt: typeof session.created_at === 'string' ? session.created_at : null,
                              updatedAt: typeof session.updated_at === 'string' ? session.updated_at : null,
                              lastActivity:
                                typeof session.lastActivity === 'string'
                                  ? session.lastActivity
                                  : typeof session.updated_at === 'string'
                                    ? session.updated_at
                                    : typeof session.created_at === 'string'
                                      ? session.created_at
                                      : null,
                              isProjectArchived: true,
                              avatarUrl: session.avatarUrl,
                            })}
                          >
                            <SidebarSessionAvatar
                              provider={session.__provider}
                              avatarUrl={session.avatarUrl}
                            />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="truncate text-xs font-normal text-foreground">
                                  {(typeof session.summary === 'string' && session.summary.trim().length > 0
                                    ? session.summary
                                    : typeof session.name === 'string' && session.name.trim().length > 0
                                      ? session.name
                                      : String(session.id))}
                                </span>
                                <span className="ml-auto flex-shrink-0 text-[11px] text-muted-foreground">
                                  {formatCompactAge(
                                    typeof session.lastActivity === 'string'
                                      ? session.lastActivity
                                      : typeof session.updated_at === 'string'
                                        ? session.updated_at
                                        : typeof session.created_at === 'string'
                                          ? session.created_at
                                          : null,
                                    projectListProps.currentTime,
                                  )}
                                </span>
                              </div>
                              <p className="mt-0.5 text-[11px] uppercase tracking-wide text-muted-foreground/70">
                                {session.__provider}
                              </p>
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
              {groupedArchivedSessions.map((group) => (
                <div key={group.key} className="overflow-hidden rounded-xl border border-border/70 bg-card/60 shadow-sm">
                  <div className="flex items-start justify-between gap-3 border-b border-border/60 px-3 py-2.5">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Folder className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                        <span className="truncate text-sm font-normal text-foreground">
                          {group.projectDisplayName}
                        </span>
                        {group.isProjectArchived && (
                          <span className="inline-flex items-center justify-center rounded-full bg-muted px-1 py-px text-center text-[7px] font-medium uppercase leading-none tracking-[0.02em] text-muted-foreground">
                            {t('archived.projectArchived', 'Project archived')}
                          </span>
                        )}
                      </div>
                      {group.projectPath && (
                        <p className="mt-1 truncate text-xs text-muted-foreground/70" title={group.projectPath}>
                          {group.projectPath}
                        </p>
                      )}
                    </div>
                    <span className="flex-shrink-0 text-[11px] text-muted-foreground">
                      {group.sessions.length}
                    </span>
                  </div>
                  <div className="divide-y divide-border/50">
                    {group.sessions.map((session) => (
                      <div key={session.sessionId} className="flex items-center gap-2 px-3 py-2.5">
                        <button
                          className="flex min-w-0 flex-1 items-center gap-2 text-left transition-colors hover:text-foreground"
                          onClick={() => onArchivedSessionClick(session)}
                        >
                          <SidebarSessionAvatar
                            provider={session.provider}
                            avatarUrl={session.avatarUrl}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="truncate text-xs font-normal text-foreground">
                                {session.sessionTitle}
                              </span>
                              {session.lastActivity && (
                                <span className="ml-auto flex-shrink-0 text-[11px] text-muted-foreground">
                                  {formatCompactAge(session.lastActivity, projectListProps.currentTime)}
                                </span>
                              )}
                            </div>
                            <p className="mt-0.5 text-[11px] uppercase tracking-wide text-muted-foreground/70">
                              {session.provider}
                            </p>
                          </div>
                        </button>
                        <button
                          className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-700 transition-colors hover:bg-emerald-100 dark:bg-emerald-900/20 dark:text-emerald-300 dark:hover:bg-emerald-900/30"
                          onClick={() => onRestoreArchivedSession(session.sessionId)}
                          title={t('archived.restore', 'Restore session')}
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                        </button>
                        <button
                          className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-red-50 text-red-700 transition-colors hover:bg-red-100 dark:bg-red-900/20 dark:text-red-300 dark:hover:bg-red-900/30"
                          onClick={() => onDeleteArchivedSession(session)}
                          title={t('archived.deletePermanently', 'Delete permanently')}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )
        ) : (
          <div className="md:space-y-1.5">
            <SidebarProjectList {...projectListProps} />
            {conversationSection && (
              <div className="mt-3 border-t border-border/60 pt-2">
                <div className="flex items-center gap-1.5 px-2 pb-1">
                  <MessageSquare className="h-3 w-3 text-muted-foreground" />
                  <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    {t('search.inConversations', 'In conversations')}
                  </span>
                </div>
                {conversationSection}
              </div>
            )}
          </div>
        );
        })()}
      </ScrollArea>
      )}

      {!isRenamingOnMobile && (
        <SidebarFooter
          updateAvailable={updateAvailable}
          restartRequired={restartRequired}
          releaseInfo={releaseInfo}
          latestVersion={latestVersion}
          onShowVersionModal={onShowVersionModal}
          onShowSettings={onShowSettings}
          t={t}
        />
      )}
    </div>
  );
}
