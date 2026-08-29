import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NavigateFunction } from 'react-router-dom';

import { getSessionProvider } from '../components/sidebar/utils/utils';
import { useWebSocketEvent } from '../contexts/WebSocketContext';
import { api } from '../utils/api';
import type {
  AppSocketMessage,
  AppTab,
  LLMProvider,
  LoadingProgress,
  Project,
  ProjectSession,
  ProjectsUpdatedMessage,
} from '../types/app';

import { reconcileSelectedSession } from './projectSessionSelection';

type UseProjectsStateArgs = {
  sessionId?: string;
  navigate: NavigateFunction;
  isMobile: boolean;
  activeSessions: Set<string>;
};

type FetchProjectsOptions = {
  showLoadingState?: boolean;
};

/**
 * The `/locate` answer — where a session lives when no sidebar list contains it.
 * Only the fields this hook needs to select it.
 */
type LocatedSession = {
  sessionId: string;
  provider: LLMProvider;
  projectId: string | null;
  sessionTitle: string | null;
};

const serialize = (value: unknown) => JSON.stringify(value ?? null);

const projectsHaveChanges = (
  prevProjects: Project[],
  nextProjects: Project[],
  includeExternalSessions: boolean,
): boolean => {
  if (prevProjects.length !== nextProjects.length) {
    return true;
  }

  return nextProjects.some((nextProject, index) => {
    const prevProject = prevProjects[index];
    if (!prevProject) {
      return true;
    }

    const baseChanged =
      nextProject.projectId !== prevProject.projectId ||
      nextProject.displayName !== prevProject.displayName ||
      nextProject.fullPath !== prevProject.fullPath ||
      Boolean(nextProject.isStarred) !== Boolean(prevProject.isStarred) ||
      serialize(nextProject.sessionMeta) !== serialize(prevProject.sessionMeta) ||
      serialize(nextProject.sessions) !== serialize(prevProject.sessions) ||
      serialize(nextProject.taskmaster) !== serialize(prevProject.taskmaster);

    if (baseChanged) {
      return true;
    }

    if (!includeExternalSessions) {
      return false;
    }

    return (
      serialize(nextProject.cursorSessions) !== serialize(prevProject.cursorSessions) ||
      serialize(nextProject.codexSessions) !== serialize(prevProject.codexSessions) ||
      serialize(nextProject.geminiSessions) !== serialize(prevProject.geminiSessions) ||
      serialize(nextProject.opencodeSessions) !== serialize(prevProject.opencodeSessions)
    );
  });
};

const mergeTaskMasterCache = (nextProjects: Project[], previousProjects: Project[]): Project[] => {
  if (previousProjects.length === 0) {
    return nextProjects;
  }

  // Keyed by `projectId` (the DB primary key) so caches stay correct across
  // renames and other mutations that might have changed the display name.
  const previousTaskMasterByProject = new Map(
    previousProjects
      .filter((project) => Boolean(project.taskmaster))
      .map((project) => [project.projectId, project.taskmaster]),
  );

  return nextProjects.map((project) => {
    const cachedTaskMasterInfo = previousTaskMasterByProject.get(project.projectId);
    if (!cachedTaskMasterInfo) {
      return project;
    }

    return {
      ...project,
      taskmaster: cachedTaskMasterInfo,
    };
  });
};

const getProjectSessions = (project: Project): ProjectSession[] => {
  return [
    ...(project.sessions ?? []),
    ...(project.codexSessions ?? []),
    ...(project.cursorSessions ?? []),
    ...(project.geminiSessions ?? []),
    ...(project.opencodeSessions ?? []),
  ];
};

const countLoadedProjectSessions = (project: Project): number => getProjectSessions(project).length;

/**
 * Every list a session could be sitting in.
 *
 * The server sends them all in `sessions`, each tagged with its own provider;
 * the per-provider buckets are legacy and no payload fills them any more. They
 * are still searched when updating a session in place, so a client holding an
 * older snapshot keeps working — but nothing renders them, so a session may
 * only ever be *inserted* into `sessions`.
 */
const SESSION_LIST_KEYS: Array<keyof Project> = [
  'sessions',
  'codexSessions',
  'cursorSessions',
  'geminiSessions',
  'opencodeSessions',
];

/**
 * Applies one `session_upserted` delta to the project list.
 *
 * Updates the session in place wherever it already is — which provider list it
 * lives in is not the delta's business — and only falls back to inserting when
 * the session is genuinely new, which needs the owning project to be known.
 * Returns the original array when nothing matched, so React skips the re-render.
 */
const upsertSessionIntoProjects = (
  projects: Project[],
  sessionId: string,
  incoming: Partial<ProjectSession>,
  provider?: LLMProvider,
  projectId?: string,
): Project[] => {
  let changed = false;

  const updated = projects.map((project) => {
    let projectChanged = false;
    const nextProject: Project = { ...project };

    for (const listKey of SESSION_LIST_KEYS) {
      const list = nextProject[listKey] as ProjectSession[] | undefined;
      if (!Array.isArray(list)) continue;

      const index = list.findIndex((session) => String(session.id) === sessionId);
      if (index === -1) continue;

      const nextList = [...list];
      nextList[index] = { ...nextList[index], ...incoming, id: nextList[index].id };
      (nextProject[listKey] as ProjectSession[]) = nextList;
      projectChanged = true;
    }

    if (projectChanged) {
      changed = true;
      return nextProject;
    }
    return project;
  });

  if (changed) {
    return updated;
  }

  // Not on the list yet — a session that has only just been indexed. It goes
  // into `sessions` whatever its provider: that is the one list the sidebar
  // reads, and the provider travels with the row instead of with the bucket.
  if (!projectId || !provider) {
    return projects;
  }

  return projects.map((project) => {
    if (project.projectId !== projectId) return project;

    changed = true;
    const list = project.sessions ?? [];
    return {
      ...project,
      sessions: [{ ...incoming, id: sessionId, __provider: provider } as ProjectSession, ...list],
    };
  });
};

const mergeSessionProviderLists = (baseSessions: ProjectSession[], additionalSessions: ProjectSession[]): ProjectSession[] => {
  const merged = [...baseSessions];
  const seenSessionIds = new Set(baseSessions.map((session) => String(session.id)));

  for (const session of additionalSessions) {
    const sessionId = String(session.id);
    if (seenSessionIds.has(sessionId)) {
      continue;
    }

    merged.push(session);
    seenSessionIds.add(sessionId);
  }

  return merged;
};

const getSessionActivityTime = (session: ProjectSession): number => {
  const raw = session.lastActivity ?? session.updated_at ?? session.created_at ?? session.createdAt;
  const parsed = raw ? Date.parse(String(raw)) : Number.NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
};

const mergeExpandedSessionPages = (previousProjects: Project[], incomingProjects: Project[]): Project[] => {
  if (previousProjects.length === 0) {
    return incomingProjects;
  }

  const previousByProjectId = new Map(previousProjects.map((project) => [project.projectId, project]));

  return incomingProjects.map((incomingProject) => {
    const previousProject = previousByProjectId.get(incomingProject.projectId);
    if (!previousProject) {
      return incomingProject;
    }

    const previousLoadedCount = countLoadedProjectSessions(previousProject);
    const incomingLoadedCount = countLoadedProjectSessions(incomingProject);
    if (previousLoadedCount <= incomingLoadedCount) {
      return incomingProject;
    }

    // When the server reports no further pages, the incoming payload is the
    // complete session list — re-adding anything from the previous state would
    // resurrect sessions deleted or archived elsewhere (another tab, the
    // localStorage cache from a prior visit).
    if (!incomingProject.sessionMeta?.hasMore) {
      return incomingProject;
    }

    // The incoming payload only carries the newest session page (ordered by
    // recency across providers). A previously loaded session can only still be
    // valid if it falls strictly below that page window: anything at least as
    // recent as the oldest incoming session would have been included in the
    // page if it still existed, so a missing one was deleted — drop it.
    const incomingSessions = getProjectSessions(incomingProject);
    const pageBoundary = incomingSessions.length > 0
      ? Math.min(...incomingSessions.map(getSessionActivityTime))
      : Number.POSITIVE_INFINITY;
    const keepPagedOutSessions = (sessions: ProjectSession[] | undefined) =>
      (sessions ?? []).filter((session) => getSessionActivityTime(session) < pageBoundary);

    const mergedProject: Project = {
      ...incomingProject,
      sessions: mergeSessionProviderLists(incomingProject.sessions ?? [], keepPagedOutSessions(previousProject.sessions)),
      cursorSessions: mergeSessionProviderLists(incomingProject.cursorSessions ?? [], keepPagedOutSessions(previousProject.cursorSessions)),
      codexSessions: mergeSessionProviderLists(incomingProject.codexSessions ?? [], keepPagedOutSessions(previousProject.codexSessions)),
      geminiSessions: mergeSessionProviderLists(incomingProject.geminiSessions ?? [], keepPagedOutSessions(previousProject.geminiSessions)),
      opencodeSessions: mergeSessionProviderLists(incomingProject.opencodeSessions ?? [], keepPagedOutSessions(previousProject.opencodeSessions)),
    };

    const totalSessions = Number(incomingProject.sessionMeta?.total ?? previousLoadedCount);
    mergedProject.sessionMeta = {
      ...incomingProject.sessionMeta,
      total: totalSessions,
      hasMore: countLoadedProjectSessions(mergedProject) < totalSessions,
    };

    return mergedProject;
  });
};

const mergeProjectSessionPage = (
  existingProject: Project,
  sessionsPage: Pick<Project, 'sessions' | 'cursorSessions' | 'codexSessions' | 'geminiSessions' | 'opencodeSessions' | 'sessionMeta'>,
): Project => {
  const mergedProject: Project = {
    ...existingProject,
    sessions: mergeSessionProviderLists(existingProject.sessions ?? [], sessionsPage.sessions ?? []),
    cursorSessions: mergeSessionProviderLists(existingProject.cursorSessions ?? [], sessionsPage.cursorSessions ?? []),
    codexSessions: mergeSessionProviderLists(existingProject.codexSessions ?? [], sessionsPage.codexSessions ?? []),
    geminiSessions: mergeSessionProviderLists(existingProject.geminiSessions ?? [], sessionsPage.geminiSessions ?? []),
    opencodeSessions: mergeSessionProviderLists(existingProject.opencodeSessions ?? [], sessionsPage.opencodeSessions ?? []),
  };

  const totalSessions = Number(sessionsPage.sessionMeta?.total ?? existingProject.sessionMeta?.total ?? 0);
  mergedProject.sessionMeta = {
    ...existingProject.sessionMeta,
    ...sessionsPage.sessionMeta,
    total: totalSessions,
    hasMore: countLoadedProjectSessions(mergedProject) < totalSessions,
  };

  return mergedProject;
};

/**
 * Whether a projects refresh is safe to apply while a run is in flight.
 *
 * The thing worth protecting is the session you are looking at: if a refresh
 * arrives without it — mid-index, a project page that hasn't caught up — taking
 * it would yank the open session out from under an active run.
 *
 * It used to also reject any refresh in which the selected session's title or
 * `updated_at` had moved, which is the opposite of what you want: those are
 * exactly the refreshes carrying news. A session goes active the moment you
 * send its first message, so from then on every update that renamed it (the
 * derived title arriving) or added a sibling row was discarded — the pane
 * header sat on "New session" and the new row was missing from the drawer until
 * a reload rebuilt the list from scratch.
 */
const isUpdateAdditive = (
  currentProjects: Project[],
  updatedProjects: Project[],
  selectedProject: Project | null,
  selectedSession: ProjectSession | null,
): boolean => {
  if (!selectedProject || !selectedSession) {
    return true;
  }

  const updatedSelectedProject = updatedProjects.find((project) => project.projectId === selectedProject.projectId);
  if (!updatedSelectedProject) {
    return false;
  }

  // Present in the incoming list is the whole test. Its title/timestamps are
  // free to differ — that is the update doing its job.
  return getProjectSessions(updatedSelectedProject).some((session) => session.id === selectedSession.id);
};

const PROJECTS_CACHE_KEY = 'projects-cache-v1';

const readProjectsCache = (): Project[] | null => {
  try {
    const raw = localStorage.getItem(PROJECTS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Project[]) : null;
  } catch {
    return null;
  }
};

const writeProjectsCache = (projects: Project[]) => {
  try {
    localStorage.setItem(PROJECTS_CACHE_KEY, JSON.stringify(projects));
  } catch {
    // Quota exceeded or storage unavailable — ignore silently.
  }
};

export function useProjectsState({
  sessionId,
  navigate,
  isMobile,
  activeSessions,
}: UseProjectsStateArgs) {
  // Seed projects from localStorage so the shell paints instantly on iOS
  // Safari resume (which otherwise blanks until /api/projects round-trips).
  // The fetch below refreshes in the background.
  const [hadCachedProjectsOnMount] = useState<boolean>(() => readProjectsCache() !== null);
  const [projects, setProjects] = useState<Project[]>(() => readProjectsCache() ?? []);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [selectedSession, setSelectedSession] = useState<ProjectSession | null>(null);
  // Tab/panel selection moved to useWorkspaceTabs (per-project workspace
  // tabs); this hook only owns project/session selection now.

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isLoadingProjects, setIsLoadingProjects] = useState(!hadCachedProjectsOnMount);
  const [loadingProgress, setLoadingProgress] = useState<LoadingProgress | null>(null);
  const [isInputFocused, setIsInputFocused] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState('agents');
  const [externalMessageUpdate, setExternalMessageUpdate] = useState(0);
  /**
   * `newSessionTrigger` is an explicit, monotonic intent signal for user-driven
   * New Session actions.
   *
   * It exists because `handleNewSession` can be invoked while the app is already in
   * the same visible state (`selectedSession === null`, `activeTab === 'chat'`,
   * route already `/`). In that case, React/router updates are idempotent and no
   * downstream reset logic runs.
   *
   * Usage across the codebase:
   * 1) Produced here in `handleNewSession` via increment (always changes).
   * 2) Returned from this hook and threaded through:
   *    useProjectsState -> AppContent -> MainContent -> ChatInterface.
   * 3) Consumed in `useChatSessionState` as an effect dependency to forcibly clear
   *    chat-local state (`currentSessionId`, pending draft message, streaming flags,
   *    pending session storage keys, pagination/scroll artifacts).
   *
   * Keeping this signal dedicated avoids coupling resets to unrelated counters/events
   * (for example websocket/project refresh updates) that could cause accidental resets.
   */
  const [newSessionTrigger, setNewSessionTrigger] = useState(0);

  const loadingProgressTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Deep-link lookups already attempted, so a session the server does not know
   * (or one that answers under a different id) cannot re-fire the request on
   * every render of the effect below.
   */
  const locateAttemptedRef = useRef<Set<string>>(new Set());

  const fetchProjects = useCallback(async ({ showLoadingState = true }: FetchProjectsOptions = {}) => {
    try {
      if (showLoadingState) {
        setIsLoadingProjects(true);
      }
      const response = await api.projects();
      const projectData = (await response.json()) as Project[];

      setProjects((prevProjects) => {
        const projectsWithTaskMaster = mergeTaskMasterCache(projectData, prevProjects);
        const mergedProjects = mergeExpandedSessionPages(prevProjects, projectsWithTaskMaster);

        if (prevProjects.length === 0) {
          return mergedProjects;
        }

        return projectsHaveChanges(prevProjects, mergedProjects, true)
          ? mergedProjects
          : prevProjects;
      });
    } catch (error) {
      console.error('Error fetching projects:', error);
    } finally {
      if (showLoadingState) {
        setIsLoadingProjects(false);
      }
    }
  }, []);

  const refreshProjectsSilently = useCallback(async () => {
    // Keep chat view stable while still syncing sidebar/session metadata in background.
    await fetchProjects({ showLoadingState: false });
  }, [fetchProjects]);

  // Hydrates TaskMaster details for the given `projectId`. The project
  // identifier comes directly from the DB-driven /api/projects response.
  const hydrateProjectTaskMaster = useCallback(async (projectId: string) => {
    if (!projectId) {
      return;
    }

    try {
      const response = await api.projectTaskmaster(projectId);
      if (!response.ok) {
        return;
      }

      const data = (await response.json()) as { taskmaster?: Project['taskmaster'] };
      const taskMasterInfo = data.taskmaster;
      if (!taskMasterInfo) {
        return;
      }

      setProjects((previousProjects) =>
        previousProjects.map((project) =>
          project.projectId === projectId
            ? { ...project, taskmaster: taskMasterInfo }
            : project,
        ),
      );

      setSelectedProject((previousProject) => {
        if (!previousProject || previousProject.projectId !== projectId) {
          return previousProject;
        }

        return {
          ...previousProject,
          taskmaster: taskMasterInfo,
        };
      });
    } catch (error) {
      console.error(`Error fetching TaskMaster info for project ${projectId}:`, error);
    }
  }, []);

  const openSettings = useCallback((tab = 'tools') => {
    setSettingsInitialTab(tab);
    setShowSettings(true);
  }, []);

  useEffect(() => {
    // If we already painted from the localStorage cache, refresh quietly —
    // showing the spinner here would flash over a usable UI.
    void fetchProjects({ showLoadingState: !hadCachedProjectsOnMount });
  }, [fetchProjects, hadCachedProjectsOnMount]);

  useEffect(() => {
    if (projects.length === 0) return;
    writeProjectsCache(projects);
  }, [projects]);

  useEffect(() => {
    if (!selectedProject?.projectId) {
      return;
    }

    void hydrateProjectTaskMaster(selectedProject.projectId);
  }, [hydrateProjectTaskMaster, selectedProject?.projectId]);

  // Auto-select the project when there is only one, so the user lands on the new session page
  useEffect(() => {
    if (!isLoadingProjects && projects.length === 1 && !selectedProject && !sessionId) {
      setSelectedProject(projects[0]);
    }
  }, [isLoadingProjects, projects, selectedProject, sessionId]);

  // Delivered once per inbound frame, in order — no React-batch coalescing and
  // no self-retrigger from the local-state reads below, so the old
  // identity-dedup ref is unnecessary.
  useWebSocketEvent((raw) => {
    const latestMessage = raw as AppSocketMessage | null;
    if (!latestMessage) {
      return;
    }

    if (latestMessage.type === 'loading_progress') {
      if (loadingProgressTimeoutRef.current) {
        clearTimeout(loadingProgressTimeoutRef.current);
        loadingProgressTimeoutRef.current = null;
      }

      setLoadingProgress(latestMessage as LoadingProgress);

      if (latestMessage.phase === 'complete') {
        loadingProgressTimeoutRef.current = setTimeout(() => {
          setLoadingProgress(null);
          loadingProgressTimeoutRef.current = null;
        }, 500);
      }

      return;
    }

    // Transcript-watcher delta for one session (kind-based, not type-based).
    // When it targets the session on screen and the app itself isn't driving
    // that session (no active run), the transcript changed underneath us —
    // e.g. the conversation is happening in the Terminal tab's CLI, or in
    // another client — so nudge the chat view to refetch its history.
    const upsertedMessage = latestMessage as {
      kind?: string;
      sessionId?: string;
      provider?: LLMProvider;
      session?: Partial<ProjectSession>;
      project?: { projectId?: string } | null;
    };
    if (upsertedMessage.kind === 'session_upserted') {
      const upsertedSessionId =
        typeof upsertedMessage.sessionId === 'string' ? upsertedMessage.sessionId : null;

      // Apply the delta to the list. This event carries the session's current
      // summary/recap and is the only prompt notice of a rename or a newly
      // indexed session — a full `projects_updated` may be many seconds away,
      // which is why a new session used to sit missing from the drawer and a
      // regenerated title never showed up until a reload. Merging one session
      // cannot disturb anything else, so unlike a full snapshot it is safe to
      // apply while a run is in flight.
      if (upsertedSessionId && upsertedMessage.session) {
        setProjects((previousProjects) =>
          upsertSessionIntoProjects(
            previousProjects,
            upsertedSessionId,
            upsertedMessage.session as Partial<ProjectSession>,
            upsertedMessage.provider,
            upsertedMessage.project?.projectId,
          ),
        );
      }

      if (
        upsertedSessionId &&
        selectedSession &&
        upsertedSessionId === selectedSession.id &&
        !activeSessions.has(upsertedSessionId)
      ) {
        setExternalMessageUpdate((prev) => prev + 1);
      }
      return;
    }

    if (latestMessage.type !== 'projects_updated') {
      return;
    }

    const projectsMessage = latestMessage as ProjectsUpdatedMessage;

    if (projectsMessage.updatedSessionId && selectedSession && selectedProject) {
      if (projectsMessage.updatedSessionId === selectedSession.id) {
        const isSessionActive = activeSessions.has(selectedSession.id);

        if (!isSessionActive) {
          setExternalMessageUpdate((prev) => prev + 1);
        }
      }
    }

    const hasActiveSession = Boolean(selectedSession && activeSessions.has(selectedSession.id));

    const updatedProjectsWithTaskMaster = mergeTaskMasterCache(projectsMessage.projects, projects);
    const updatedProjects = mergeExpandedSessionPages(projects, updatedProjectsWithTaskMaster);

    if (
      hasActiveSession &&
      !isUpdateAdditive(projects, updatedProjects, selectedProject, selectedSession)
    ) {
      return;
    }

    setProjects((previousProjects) =>
      projectsHaveChanges(previousProjects, updatedProjects, true) ? updatedProjects : previousProjects,
    );

    if (!selectedProject) {
      return;
    }

    const updatedSelectedProject = updatedProjects.find(
      (project) => project.projectId === selectedProject.projectId,
    );

    if (!updatedSelectedProject) {
      return;
    }

    if (serialize(updatedSelectedProject) !== serialize(selectedProject)) {
      setSelectedProject(updatedSelectedProject);
    }

    if (!selectedSession) {
      return;
    }

    const updatedSelectedSession = getProjectSessions(updatedSelectedProject).find(
      (session) => session.id === selectedSession.id,
    );

    if (!updatedSelectedSession) {
      setSelectedSession(null);
    }
  });

  useEffect(() => {
    return () => {
      if (loadingProgressTimeoutRef.current) {
        clearTimeout(loadingProgressTimeoutRef.current);
        loadingProgressTimeoutRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!sessionId || projects.length === 0) {
      return;
    }

    // Project membership is resolved through `projectId` after the migration.
    //
    // Every session — whatever its provider — arrives in the single `sessions`
    // array carrying its own `provider`; the per-provider buckets the server
    // used to send are gone. Matching against `sessions` and then hard-coding
    // `__provider: 'claude'` therefore relabelled *every* codex/cursor/opencode
    // session as Claude on each projects refresh, which flipped the composer's
    // provider (and with it the model) and sent Claude aliases like `opus` to
    // the codex CLI. Derive the provider from the row instead.
    for (const project of projects) {
      const session = project.sessions?.find((entry) => entry.id === sessionId);
      if (session) {
        const sessionProvider = getSessionProvider(session);
        const shouldUpdateProject = selectedProject?.projectId !== project.projectId;
        const reconciledSession = reconcileSelectedSession(selectedSession, session, sessionProvider);

        if (shouldUpdateProject) {
          setSelectedProject(project);
        }
        if (reconciledSession !== selectedSession) {
          setSelectedSession(reconciledSession);
        }
        return;
      }
    }

    // Session id is in the URL but not yet present on any project payload (common
    // right after `session_created` + navigate, before the next projects refresh).
    // Without a `selectedSession`, chat state clears `currentSessionId` and the
    // UI stops reading the session store even though messages stream under this id.
    if (selectedSession?.id === sessionId) {
      return;
    }

    if (!selectedProject) {
      // A cold load of a deep link: no project is selected, so there is nothing
      // to synthesize a selection from. Ask the server where the session lives.
      //
      // The sidebar payload is deliberately narrow — `isArchived = 0`,
      // `is_side = 0`, newest 20 rows per project — so a perfectly valid URL can
      // name a session it does not contain. An external board links straight to
      // `/session/:id`, and so does a bookmark or a reload after archiving.
      // Until this lookup existed, every one of those rendered the blank
      // new-session screen, which reads as "the link is broken".
      if (locateAttemptedRef.current.has(sessionId)) {
        return;
      }
      locateAttemptedRef.current.add(sessionId);

      let cancelled = false;
      void (async () => {
        try {
          const response = await api.locateSession(sessionId);
          if (cancelled || !response.ok) {
            return;
          }

          const payload = (await response.json()) as { data?: { session?: LocatedSession } };
          const located = payload.data?.session;
          if (cancelled || !located) {
            return;
          }

          // The owning project may itself be archived and therefore absent from
          // `projects`. The session still opens: `__projectId` carries the
          // context the chat pane needs, exactly as the archive list's own
          // open action does.
          const owner = located.projectId
            ? projects.find((candidate) => candidate.projectId === located.projectId)
            : undefined;
          if (owner) {
            setSelectedProject(owner);
          }
          setSelectedSession({
            id: located.sessionId,
            summary: located.sessionTitle ?? '',
            __provider: located.provider,
            __projectId: located.projectId ?? owner?.projectId ?? undefined,
          });

          // The lookup also accepts a provider-native id, and callers outside
          // this app hold whichever id they saw first. Put the row's own id in
          // the address bar so a reload resolves without the round trip.
          if (located.sessionId !== sessionId) {
            navigate(`/session/${located.sessionId}`, { replace: true });
          }
        } catch (error) {
          console.error('[Projects] Failed to resolve the session named in the URL:', error);
        }
      })();

      return () => {
        cancelled = true;
      };
    }

    let providerFromStorage: string | null = null;
    try {
      providerFromStorage = localStorage.getItem('selected-provider');
    } catch {
      providerFromStorage = null;
    }

    const normalizedProvider: LLMProvider =
      providerFromStorage === 'cursor'
        ? 'cursor'
        : providerFromStorage === 'codex'
          ? 'codex'
          : providerFromStorage === 'opencode'
            ? 'opencode'
            : 'claude';

    setSelectedSession({
      id: sessionId,
      __provider: normalizedProvider,
      __projectId: selectedProject.projectId,
      summary: '',
    });
  }, [sessionId, projects, selectedProject, selectedSession, navigate]);

  const handleProjectSelect = useCallback(
    (project: Project) => {
      setSelectedProject(project);
      setSelectedSession(null);
      navigate('/');

      // Deliberately leaves the drawer open on narrow layouts. Tapping a project
      // only stages a new session; the usual next move is picking one of that
      // project's existing sessions, which the list right below now reveals.
      // Closing here forced the user to re-open the drawer every time. The
      // explicit "new session" action still collapses it (handleNewSession), as
      // does picking a session from a different project.
    },
    [navigate],
  );

  const handleSessionSelect = useCallback(
    (session: ProjectSession) => {
      setSelectedSession(session);

      const provider = localStorage.getItem('selected-provider') || 'claude';
      if (provider === 'cursor') {
        sessionStorage.setItem('cursorSessionId', session.id);
      }

      if (isMobile) {
        // Sessions are tagged with the owning project's DB `projectId` when
        // picked from the sidebar (see useSidebarController); compare against
        // the current selection's `projectId` so we know whether to collapse
        // the sidebar after navigation.
        const sessionProjectId = session.__projectId;
        const currentProjectId = selectedProject?.projectId;

        if (sessionProjectId !== currentProjectId) {
          setSidebarOpen(false);
        }
      }

      navigate(`/session/${session.id}`);
    },
    [isMobile, navigate, selectedProject?.projectId],
  );

  const handleNewSession = useCallback(
    (project: Project) => {
      setSelectedProject(project);
      setSelectedSession(null);
      setNewSessionTrigger((previous) => previous + 1);
      navigate('/');

      if (isMobile) {
        setSidebarOpen(false);
      }
    },
    [isMobile, navigate],
  );

  const handleSessionDelete = useCallback(
    (sessionIdToDelete: string) => {
      if (selectedSession?.id === sessionIdToDelete) {
        setSelectedSession(null);
        navigate('/');
      }

      setProjects((prevProjects) =>
        prevProjects.map((project) => {
          const sessions = project.sessions?.filter((session) => session.id !== sessionIdToDelete) ?? [];
          const cursorSessions = project.cursorSessions?.filter((session) => session.id !== sessionIdToDelete) ?? [];
          const codexSessions = project.codexSessions?.filter((session) => session.id !== sessionIdToDelete) ?? [];
          const geminiSessions = project.geminiSessions?.filter((session) => session.id !== sessionIdToDelete) ?? [];
          const opencodeSessions = project.opencodeSessions?.filter((session) => session.id !== sessionIdToDelete) ?? [];

          const removedFromProject = (
            sessions.length !== (project.sessions?.length ?? 0)
            || cursorSessions.length !== (project.cursorSessions?.length ?? 0)
            || codexSessions.length !== (project.codexSessions?.length ?? 0)
            || geminiSessions.length !== (project.geminiSessions?.length ?? 0)
            || opencodeSessions.length !== (project.opencodeSessions?.length ?? 0)
          );

          if (!removedFromProject) {
            return project;
          }

          const updatedProject: Project = {
            ...project,
            sessions,
            cursorSessions,
            codexSessions,
            geminiSessions,
            opencodeSessions,
          };

          const totalSessions = Math.max(0, Number(project.sessionMeta?.total ?? 0) - 1);
          updatedProject.sessionMeta = {
            ...project.sessionMeta,
            total: totalSessions,
            hasMore: countLoadedProjectSessions(updatedProject) < totalSessions,
          };

          return updatedProject;
        }),
      );
    },
    [navigate, selectedSession?.id],
  );

  const handleSidebarRefresh = useCallback(async () => {
    try {
      const response = await api.projects();
      const freshProjects = (await response.json()) as Project[];
      const projectsWithTaskMaster = mergeTaskMasterCache(freshProjects, projects);
      const mergedProjects = mergeExpandedSessionPages(projects, projectsWithTaskMaster);

      setProjects((prevProjects) =>
        projectsHaveChanges(prevProjects, mergedProjects, true) ? mergedProjects : prevProjects,
      );

      if (!selectedProject) {
        return;
      }

      const refreshedProject = mergedProjects.find((project) => project.projectId === selectedProject.projectId);
      if (!refreshedProject) {
        return;
      }

      if (serialize(refreshedProject) !== serialize(selectedProject)) {
        setSelectedProject(refreshedProject);
      }

      if (!selectedSession) {
        return;
      }

      const refreshedSession = getProjectSessions(refreshedProject).find(
        (session) => session.id === selectedSession.id,
      );

      if (refreshedSession) {
        // Keep provider metadata stable when refreshed payload doesn't include __provider.
        const normalizedRefreshedSession =
          refreshedSession.__provider || !selectedSession.__provider
            ? refreshedSession
            : { ...refreshedSession, __provider: selectedSession.__provider };

        if (serialize(normalizedRefreshedSession) !== serialize(selectedSession)) {
          setSelectedSession(normalizedRefreshedSession);
        }
      }
    } catch (error) {
      console.error('Error refreshing sidebar:', error);
    }
  }, [projects, selectedProject, selectedSession]);

  const loadMoreProjectSessions = useCallback(async (projectId: string) => {
    const project = projects.find((candidate) => candidate.projectId === projectId);
    if (!project) {
      return;
    }

    const loadedCount = countLoadedProjectSessions(project);
    const totalCount = Number(project.sessionMeta?.total ?? 0);
    if (totalCount > 0 && loadedCount >= totalCount) {
      return;
    }

    const response = await api.projectSessions(projectId, {
      limit: 20,
      offset: loadedCount,
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string | { message?: string } };
      const errorPayload = payload.error;
      const message =
        typeof errorPayload === 'string'
          ? errorPayload
          : errorPayload && typeof errorPayload === 'object' && errorPayload.message
            ? errorPayload.message
            : `Failed to load more sessions for project ${projectId}`;
      throw new Error(message);
    }

    const sessionsPage = (await response.json()) as Pick<Project, 'sessions' | 'cursorSessions' | 'codexSessions' | 'geminiSessions' | 'opencodeSessions' | 'sessionMeta'>;

    let mergedProjectForSelection: Project | null = null;
    setProjects((previousProjects) =>
      previousProjects.map((candidate) => {
        if (candidate.projectId !== projectId) {
          return candidate;
        }

        const mergedProject = mergeProjectSessionPage(candidate, sessionsPage);
        mergedProjectForSelection = mergedProject;
        return mergedProject;
      }),
    );

    if (selectedProject?.projectId === projectId && mergedProjectForSelection) {
      setSelectedProject(mergedProjectForSelection);
    }
  }, [projects, selectedProject?.projectId]);

  // `projectId` is the DB identifier passed from the sidebar's delete flow
  // after the migration away from folder-derived project names.
  const handleProjectDelete = useCallback(
    (projectId: string) => {
      if (selectedProject?.projectId === projectId) {
        setSelectedProject(null);
        setSelectedSession(null);
        navigate('/');
      }

      setProjects((prevProjects) => prevProjects.filter((project) => project.projectId !== projectId));
    },
    [navigate, selectedProject?.projectId],
  );

  const sidebarSharedProps = useMemo(
    () => ({
      projects,
      selectedProject,
      selectedSession,
      onProjectSelect: handleProjectSelect,
      onSessionSelect: handleSessionSelect,
      onNewSession: handleNewSession,
      onSessionDelete: handleSessionDelete,
      onLoadMoreSessions: loadMoreProjectSessions,
      onProjectDelete: handleProjectDelete,
      isLoading: isLoadingProjects,
      loadingProgress,
      onRefresh: handleSidebarRefresh,
      onShowSettings: () => setShowSettings(true),
      showSettings,
      settingsInitialTab,
      onCloseSettings: () => setShowSettings(false),
      isMobile,
    }),
    [
      handleNewSession,
      handleProjectDelete,
      handleProjectSelect,
      handleSessionDelete,
      loadMoreProjectSessions,
      handleSessionSelect,
      handleSidebarRefresh,
      isLoadingProjects,
      isMobile,
      loadingProgress,
      projects,
      settingsInitialTab,
      selectedProject,
      selectedSession,
      showSettings,
    ],
  );

  return {
    projects,
    selectedProject,
    selectedSession,
    sidebarOpen,
    isLoadingProjects,
    loadingProgress,
    isInputFocused,
    showSettings,
    settingsInitialTab,
    externalMessageUpdate,
    newSessionTrigger,
    setSidebarOpen,
    setIsInputFocused,
    setShowSettings,
    openSettings,
    fetchProjects,
    refreshProjectsSilently,
    sidebarSharedProps,
    handleProjectSelect,
    handleSessionSelect,
    handleNewSession,
    handleSessionDelete,
    loadMoreProjectSessions,
    handleProjectDelete,
    handleSidebarRefresh,
  };
}
