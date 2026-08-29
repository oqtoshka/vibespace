import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { broadcastSessionUpdate } from '@/modules/providers/services/sessions-watcher.service.js';
import { sessionShredService } from '@/modules/providers/services/session-shred.service.js';
import type { ShredReport } from '@/modules/providers/services/session-shred.service.js';
import type {
  FetchHistoryOptions,
  FetchHistoryResult,
  LLMProvider,
  NormalizedMessage,
  RewindResult,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/**
 * How long after discarding a helper session to re-check that the session
 * indexer did not import it in the meantime. Comfortably past the watcher's
 * 500 ms / 2 s debounce.
 */
const PROVIDER_SESSION_SWEEP_MS = 5_000;

type CreateAppSessionResult = {
  sessionId: string;
  provider: LLMProvider;
  projectPath: string;
  isSide: boolean;
  isPrivate: boolean;
  sessionName: string;
};

type ArchivedSessionListItem = {
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
  isPrivate: boolean;
};

type RecentSessionListItem = Pick<
  ArchivedSessionListItem,
  'sessionId' | 'provider' | 'projectId' | 'projectDisplayName' | 'sessionTitle' | 'lastActivity'
>;

type RecentSessionsPage = {
  conversations: RecentSessionListItem[];
  total: number;
  hasMore: boolean;
};

type SessionDetails = {
  /** Canonical app-facing session id (may differ from the looked-up id when a provider-native id was given). */
  sessionId: string;
  provider: LLMProvider;
  summary: string;
  createdAt: string | null;
  updatedAt: string | null;
  lastActivity: string | null;
  isArchived: boolean;
  project: {
    projectId: string;
    path: string;
    fullPath: string;
    displayName: string;
    isStarred: boolean;
    isArchived: boolean;
  } | null;
};

const MAX_CLOUDCLI_SESSION_NAME_WORDS = 4;
const SESSION_PLACEHOLDER_NAMES = new Set([
  'Untitled Session',
  'Untitled Claude Session',
  'Untitled Codex Session',
  'Untitled Cursor Session',
  'Untitled OpenCode Session',
]);

function buildCloudCliSessionName(initialMessage: string): string {
  const words = initialMessage.trim().split(/\s+/).filter(Boolean);
  return words.slice(0, MAX_CLOUDCLI_SESSION_NAME_WORDS).join(' ') || 'Untitled Session';
}

/**
 * The same row, plus the two flags that say why a list may not contain it.
 * A client resolving a deep link needs them to explain what it opened.
 */
type LocatedSession = ArchivedSessionListItem & {
  isArchived: boolean;
  isSide: boolean;
};

type PersistedSession = NonNullable<ReturnType<typeof sessionsDb.getSessionById>>;

/**
 * Removes one file if it exists.
 */
async function removeFileIfExists(filePath: string): Promise<boolean> {
  try {
    await fsp.unlink(filePath);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

/**
 * Asks the provider to erase its own copy of one session, when it can.
 *
 * Optional on the provider contract: file-backed providers already lose the
 * session with their transcript file, so only shared-store providers implement
 * it. A failure here must not abort the delete — the app row still goes.
 */
async function deleteProviderSession(
  provider: LLMProvider,
  providerSessionId: string,
): Promise<boolean> {
  try {
    const sessions = providerRegistry.resolveProvider(provider).sessions;
    return await sessions.deleteSession?.(providerSessionId) ?? false;
  } catch (error) {
    console.warn(`[Sessions] Provider "${provider}" failed to delete ${providerSessionId}:`, error);
    return false;
  }
}

/**
 * Permanently deletes every session that belongs to one project path.
 *
 * Deleting a project has to take its conversations with it, and deleting the
 * app's own rows is not enough to do that: a provider that keeps its sessions
 * in one shared store (OpenCode's `opencode.db`) still has them, so the next
 * synchronizer pass re-imports each one — and re-creating a session re-creates
 * the project row it hangs off, which brought the whole deleted project back
 * into the sidebar. Each session therefore goes through the same steps a single
 * force-delete takes: unlink the transcript, ask the provider to erase its own
 * copy, then drop the row.
 *
 * Every session is attempted even if an earlier one fails, so one unreadable
 * transcript cannot leave the rest of the project half-deleted.
 */
export async function deleteSessionsForProjectPath(projectPath: string): Promise<number> {
  const sessions = sessionsDb.getSessionsByProjectPathIncludingArchived(projectPath);
  let deleted = 0;

  for (const session of sessions) {
    try {
      if (session.jsonl_path) {
        await removeFileIfExists(session.jsonl_path);
      }

      await deleteProviderSession(
        session.provider as LLMProvider,
        session.provider_session_id ?? session.session_id,
      );

      if (sessionsDb.deleteSessionById(session.session_id)) {
        deleted += 1;
      }
    } catch (error) {
      console.warn(`[Sessions] Failed to delete ${session.session_id} with its project:`, error);
    }
  }

  // Backstop for rows the loop could not delete individually: the project row is
  // about to go, and sessions may not outlive the foreign key that owns them.
  sessionsDb.deleteSessionsByProjectPath(projectPath);

  return deleted;
}

/**
 * Archive rows need a stable project label even when the owning project is not
 * part of the active sidebar payload. This lightweight resolver keeps the
 * archive API self-contained while still matching the project's stored display
 * name when one exists.
 */
function resolveProjectDisplayName(
  projectPath: string | null,
  customProjectName: string | null | undefined,
): string {
  const trimmedCustomName = typeof customProjectName === 'string' ? customProjectName.trim() : '';
  if (trimmedCustomName.length > 0) {
    return trimmedCustomName;
  }

  if (!projectPath) {
    return 'Unknown Project';
  }

  return path.basename(projectPath) || projectPath;
}

/**
 * One session row as the client sees it: the session's own fields plus enough
 * project context to select it without a follow-up query.
 *
 * `projectCache` exists for the list caller, which maps hundreds of rows and
 * would otherwise re-read the same project row for each one.
 */
function toSessionListItem(
  session: PersistedSession,
  projectCache?: Map<string, ReturnType<typeof projectsDb.getProjectPath>>,
): LocatedSession {
  const projectPath = session.project_path?.trim() ? session.project_path : null;
  let project = null;

  if (projectPath) {
    if (projectCache) {
      if (!projectCache.has(projectPath)) {
        projectCache.set(projectPath, projectsDb.getProjectPath(projectPath));
      }
      project = projectCache.get(projectPath) ?? null;
    } else {
      project = projectsDb.getProjectPath(projectPath);
    }
  }

  return {
    sessionId: session.session_id,
    provider: session.provider as LLMProvider,
    projectId: project?.project_id ?? null,
    projectPath,
    projectDisplayName: resolveProjectDisplayName(projectPath, project?.custom_project_name),
    sessionTitle: session.custom_name?.trim() || session.session_id,
    createdAt: session.created_at ?? null,
    updatedAt: session.updated_at ?? null,
    lastActivity: session.updated_at ?? session.created_at ?? null,
    isProjectArchived: Boolean(project?.isArchived),
    isPrivate: Boolean(session.is_private),
    isArchived: Boolean(session.isArchived),
    isSide: Boolean(session.is_side),
  };
}

/**
 * Application service for provider-backed session message operations.
 *
 * Callers pass a provider id and this service resolves the concrete provider
 * class, keeping normalization/history call sites decoupled from implementation
 * file layout.
 */
export const sessionsService = {
  /**
   * Lists provider ids that can load session history and normalize live messages.
   */
  listProviderIds(): LLMProvider[] {
    return providerRegistry.listProviders().map((provider) => provider.id);
  },

  /**
   * Returns app-facing ids for provider runs that are currently processing.
   *
   * This is intentionally status-only: callers that only need sidebar activity
   * indicators should not attach to chat streams or request replayed messages.
   */
  listRunningSessions(): Array<{
    sessionId: string;
    provider: LLMProvider;
    startedAt: number;
    lastSeq: number;
  }> {
    return chatRunRegistry.listRunningRuns();
  },

  /**
   * Returns the active conversation feed in true global activity order.
   */
  listRecentSessions(limit: number, offset: number): RecentSessionsPage {
    const page = sessionsDb.getRecentSessionsPage(limit, offset);
    const projectCache = new Map<string, ReturnType<typeof projectsDb.getProjectPath>>();
    const conversations = page.sessions.map((session) => {
      const projectPath = session.project_path?.trim() ? session.project_path : null;
      let project = null;

      if (projectPath) {
        if (!projectCache.has(projectPath)) {
          projectCache.set(projectPath, projectsDb.getProjectPath(projectPath));
        }
        project = projectCache.get(projectPath) ?? null;
      }

      return {
        sessionId: session.session_id,
        provider: session.provider as LLMProvider,
        projectId: project?.project_id ?? null,
        projectDisplayName: resolveProjectDisplayName(projectPath, project?.custom_project_name),
        sessionTitle: session.custom_name?.trim() || session.session_id,
        lastActivity: session.updated_at ?? session.created_at ?? null,
      };
    });

    return {
      conversations,
      total: page.total,
      hasMore: offset + conversations.length < page.total,
    };
  },

  /**
   * Resolves the provider-native session id a runtime needs for resume.
   *
   * Callers hand provider runtimes the stable app session id; the provider
   * CLIs/SDKs only understand their own native id, which lives on the session
   * row. Ids without a row are assumed to be provider-native already (direct
   * API callers that reference sessions the watcher has not indexed yet).
   */
  resolveProviderSessionId(sessionId: string | null | undefined): string | null {
    if (!sessionId) {
      return null;
    }

    const session = sessionsDb.getSessionById(sessionId);
    return session ? session.provider_session_id : sessionId;
  },

  /**
   * Normalizes one provider-native event into frontend session message events.
   */
  normalizeMessage(
    providerName: string,
    raw: unknown,
    sessionId: string | null,
  ): NormalizedMessage[] {
    return providerRegistry.resolveProvider(providerName).sessions.normalizeMessage(raw, sessionId);
  },

  /**
   * Allocates a stable app-facing session id before any provider run happens.
   *
   * This is the entry point of the session gateway: the frontend calls this
   * (via `POST /api/providers/sessions`) when the user starts a brand-new
   * chat, navigates to the returned id immediately, and the id never changes
   * for the lifetime of the conversation. The provider-native id is mapped to
   * this row later, when the provider runtime announces it mid-run. Its title
   * comes directly from the first visible message (`initialMessage`) and is
   * limited to four whole words before any provider-owned storage exists.
   *
   * `isSide` allocates the session for a `/btw` question instead: identical in
   * every way, but kept out of the session lists until it is promoted.
   *
   * `isPrivate` starts the session private: every harness process that runs a
   * turn for it is spawned with the private-variant env (see collectAgentEnv), so no presence reporter
   * ever speaks for it, and VibeSpace's own notifications and recap skip it.
   * This is the only place the flag is ever set — it must precede the first
   * turn, because the reporter's SessionStart hook fires before anything here
   * could be looked up.
   *
   * Upstream callers pass the initial message as the third argument; a string
   * there is taken as the message (a side flag is always a boolean).
   */
  createAppSession(
    provider: LLMProvider,
    projectPath: string,
    isSide: boolean | string = false,
    isPrivate = false,
    initialMessage?: string,
  ): CreateAppSessionResult {
    if (typeof isSide === 'string') {
      initialMessage = isSide;
      isSide = false;
    }
    const normalizedProjectPath = projectPath.trim();
    if (!normalizedProjectPath) {
      throw new AppError('projectPath is required.', {
        code: 'PROJECT_PATH_REQUIRED',
        statusCode: 400,
      });
    }

    const sessionId = randomUUID();
    // A caller that sends the first message names the row up front — an empty
    // message still gets the stable fallback. The title is only provisional:
    // provider metadata or the background recap may replace the derived name.
    const sessionName = typeof initialMessage === 'string' ? buildCloudCliSessionName(initialMessage) : '';
    sessionsDb.createAppSession(sessionId, provider, normalizedProjectPath, isSide, isPrivate, sessionName || null);

    // The sidebar is fed by the transcript watcher, which cannot see a session
    // the provider has not written anything for yet. Without this the new chat
    // is missing from the list until the provider's store changes on disk and
    // the watcher's next poll catches it — up to several seconds after the
    // user is already looking at the conversation, and never at all if they
    // send nothing. Side sessions stay hidden by design.
    if (!isSide) {
      broadcastSessionUpdate(sessionId);
    }

    return {
      sessionId,
      provider,
      projectPath: normalizedProjectPath,
      isSide,
      isPrivate,
      sessionName,
    };
  },

  /**
   * Gives a newly allocated session its provisional first-prompt title.
   * The websocket module calls this as a compatibility fallback for browser
   * tabs and older clients that allocate without `initialMessage`.
   */
  seedDerivedSessionNameFromMessage(sessionId: string, initialMessage: string): string | null {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      return null;
    }

    const currentName = session.custom_name?.trim() || '';
    if (currentName && !SESSION_PLACEHOLDER_NAMES.has(currentName)) {
      return currentName;
    }

    const derivedName = buildCloudCliSessionName(initialMessage);
    sessionsDb.updateSessionCustomName(sessionId, derivedName, 'derived');
    broadcastSessionUpdate(sessionId);
    return derivedName;
  },

  /**
   * Throws away a provider session created purely to serve a background call.
   *
   * A helper turn (the title/recap summariser) has to run somewhere, and a
   * provider backed by a shared store gives it a session in that store like
   * any other. Left alone it would show up in the sidebar on the next import,
   * so both the provider's copy and any row already indexed for it go.
   */
  async discardProviderSession(provider: LLMProvider, providerSessionId: string): Promise<void> {
    if (!providerSessionId) {
      return;
    }

    await deleteProviderSession(provider, providerSessionId);

    const dropIndexedRow = (): void => {
      try {
        const row = sessionsDb.getSessionByProviderSessionId(providerSessionId);
        if (!row) {
          return;
        }

        // Only ever a row the importer created for this helper, which is keyed
        // by the provider id itself. An app-allocated row carries a chat the
        // user started and opened, and reaching one here means the id was bound
        // to somebody else's conversation — deleting it would take that
        // conversation with it, which is precisely what must not happen.
        if (row.session_id !== providerSessionId) {
          console.warn(
            `[Sessions] Refusing to drop app session ${row.session_id}: it claimed the helper id ${providerSessionId}.`,
          );
          return;
        }

        sessionsDb.deleteSessionById(row.session_id);
      } catch (error) {
        console.warn(`[Sessions] Could not drop the indexed row for ${providerSessionId}:`, error);
      }
    };

    dropIndexedRow();

    // And once more after the watcher's debounce window. The helper session
    // lives for as long as its turn takes, so a scan can read it out of the
    // provider's store just before this delete and write the row just after —
    // leaving a session in the sidebar that no longer exists anywhere else.
    const sweep = setTimeout(dropIndexedRow, PROVIDER_SESSION_SWEEP_MS);
    sweep.unref?.();
  },

  /**
   * Branches a `/btw` side session out into an ordinary one.
   *
   * The exchange already happened against a real provider session, so there is
   * nothing to replay or re-ask: clearing the flag is the whole operation and
   * the user continues the conversation with its context intact.
   */
  promoteSideSession(sessionId: string, fallbackName?: string): { sessionId: string } {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    // Promoting an already-promoted session is a no-op rather than an error:
    // the button can be clicked twice, and the desired end state is the same.
    const promoted = sessionsDb.promoteSideSession(sessionId, fallbackName);

    // Side sessions are suppressed from the watcher's broadcasts, so the
    // sidebar has never heard of this one. Announce it now that it is an
    // ordinary session, or it would stay invisible until the next full
    // project refetch — right as the user is being navigated to it.
    if (promoted) {
      broadcastSessionUpdate(sessionId);
    }

    return { sessionId };
  },

  /**
   * Resolves the provider-native id only for an explicit user copy action.
   * Normal session payloads continue to expose only the stable app id.
   */
  getProviderSessionId(sessionId: string): string {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    if (!session.provider_session_id) {
      throw new AppError('This session ID is not available yet.', {
        code: 'PROVIDER_SESSION_ID_NOT_AVAILABLE',
        statusCode: 409,
      });
    }

    return session.provider_session_id;
  },

  /**
   * Fetches persisted history by app session id.
   *
   * Provider and provider-specific lookup hints are resolved from the indexed
   * session metadata in the database. The provider adapter receives the
   * provider-native session id (the one written into transcripts on disk),
   * and every returned message is remapped back to the app session id so
   * provider ids never reach the frontend.
   */
  async fetchHistory(
    sessionId: string,
    options: Pick<FetchHistoryOptions, 'limit' | 'offset'> = {},
  ): Promise<FetchHistoryResult> {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    // App-created sessions that never produced a provider transcript yet
    // (e.g. first message still streaming) simply have no history.
    if (!session.provider_session_id) {
      return {
        messages: [],
        total: 0,
        hasMore: false,
        offset: options.offset ?? 0,
        limit: options.limit ?? null,
      };
    }

    const provider = session.provider as LLMProvider;
    const result = await providerRegistry.resolveProvider(provider).sessions.fetchHistory(sessionId, {
      limit: options.limit ?? null,
      offset: options.offset ?? 0,
      projectPath: session.project_path ?? '',
      providerSessionId: session.provider_session_id,
    });

    return {
      ...result,
      messages: result.messages.map((message) => ({
        ...message,
        sessionId,
      })),
    };
  },

  /**
   * Rewinds (truncates) a session's persisted transcript at the given message so
   * the conversation can be resumed in-place from that point with edited content.
   * Resolves the provider from the indexed session metadata and delegates to its
   * `rewindHistory` implementation.
   */
  async rewindHistory(sessionId: string, messageUuid: string): Promise<RewindResult> {
    // The chat runtime addresses sessions by the provider-native id; app-created
    // rows are keyed by their own `session_id` with the provider id in a
    // separate column. Accept either — looking up only by `session_id` made
    // every rewind on an app-allocated session throw SESSION_NOT_FOUND, which
    // the Claude runtime then degraded into a blank fresh session (orphaning
    // the original conversation).
    const session = sessionsDb.getSessionById(sessionId)
      ?? sessionsDb.getSessionByProviderSessionId(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    const provider = session.provider as LLMProvider;
    const sessions = providerRegistry.resolveProvider(provider).sessions;
    if (!sessions.rewindHistory) {
      throw new AppError(`Rewind is not supported for provider "${provider}".`, {
        code: 'REWIND_UNSUPPORTED',
        statusCode: 400,
      });
    }

    return sessions.rewindHistory(sessionId, messageUuid);
  },

  /**
   * Resolves one session (by app id, falling back to the provider-native id)
   * to its metadata plus the owning project.
   *
   * This backs deep links like `/session/:sessionId`: the frontend's paginated
   * project payloads only carry each project's first session page, so a
   * session opened directly by URL may not be present client-side at all —
   * this lookup is the authoritative way to learn which project owns it.
   */
  getSessionDetailsById(sessionId: string): SessionDetails {
    const session =
      sessionsDb.getSessionById(sessionId) ?? sessionsDb.getSessionByProviderSessionId(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    const projectPath = session.project_path?.trim() ? session.project_path : null;
    const project = projectPath ? projectsDb.getProjectPath(projectPath) : null;

    return {
      sessionId: session.session_id,
      provider: session.provider as LLMProvider,
      summary: session.custom_name?.trim() || '',
      createdAt: session.created_at ?? null,
      updatedAt: session.updated_at ?? null,
      lastActivity: session.updated_at ?? session.created_at ?? null,
      isArchived: Boolean(session.isArchived),
      project: project && projectPath
        ? {
            projectId: project.project_id,
            path: projectPath,
            fullPath: projectPath,
            displayName: resolveProjectDisplayName(projectPath, project.custom_project_name),
            isStarred: Boolean(project.isStarred),
            isArchived: Boolean(project.isArchived),
          }
        : null,
    };
  },

  /**
   * Returns archived sessions with enough project metadata for the sidebar to
   * group, filter, open, and restore them without a per-row follow-up query.
   */
  listArchivedSessions(): ArchivedSessionListItem[] {
    const archivedSessions = sessionsDb.getArchivedSessions();
    const projectCache = new Map<string, ReturnType<typeof projectsDb.getProjectPath>>();

    return archivedSessions.map((session) => toSessionListItem(session, projectCache));
  },

  /**
   * Where one session lives, whatever list it is or is not in.
   *
   * The sidebar payload is deliberately narrow: `isArchived = 0`, `is_side = 0`,
   * and the newest 20 rows per project. Anything outside that window still has a
   * URL — an external board links to `/session/:id`, and so does a bookmark or a
   * reload after archiving — and resolving such a link against the payload found
   * nothing, which the app rendered as its blank new-session screen. This is the
   * lookup that answers those URLs: one row by id, no list filters at all.
   *
   * Accepts a provider-native id as well, because the ids travel: an app-created
   * row is keyed by its own `session_id` and carries the provider's id in a
   * separate column, and callers outside this process hold whichever one they
   * saw first. The answer always names the row's own `session_id`.
   */
  locateSessionById(sessionId: string): LocatedSession {
    const session = sessionsDb.getSessionById(sessionId)
      ?? sessionsDb.getSessionByProviderSessionId(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    return toSessionListItem(session);
  },

  /**
   * Archives or permanently deletes one persisted session row by id.
   *
   * Soft-delete mirrors the project behavior by toggling `isArchived` so the
   * row disappears from active lists but remains restorable. Force-delete
   * optionally removes the transcript file before deleting the database row.
   *
   * `shred` goes further than force: it also removes the harness's own
   * on-disk records for the session (Claude's transcript tree and task
   * ledger, Codex's rollout and state rows, OpenCode's database rows and tool
   * output) and VibeSpace's own restore registry entry, then the row — and
   * returns a report of what went and what could not, with reasons. See
   * `session-shred.service`.
   */
  async deleteOrArchiveSessionById(
    sessionId: string,
    options: {
      force?: boolean;
      deletedFromDisk?: boolean;
      shred?: boolean;
    } = {},
  ): Promise<{
    sessionId: string;
    action: 'archived' | 'deleted' | 'shredded';
    deletedFromDisk: boolean;
    shred?: ShredReport;
  }> {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    if (options.shred) {
      const report = await sessionShredService.execute(session);
      return {
        sessionId,
        action: 'shredded',
        deletedFromDisk: report.deleted.length > 0,
        shred: report,
      };
    }

    if (!options.force) {
      sessionsDb.updateSessionIsArchived(sessionId, true);
      return {
        sessionId,
        action: 'archived',
        deletedFromDisk: false,
      };
    }

    let removedFromDisk = false;
    if (options.deletedFromDisk && session.jsonl_path) {
      removedFromDisk = await removeFileIfExists(session.jsonl_path);
    }

    // Providers with a shared store (OpenCode's single sqlite database) have no
    // per-session file to unlink, so the row above is not the whole session.
    // Without this the conversation stayed resumable in the provider CLI and
    // came back into the sidebar on the next sync.
    const removedFromProvider = await deleteProviderSession(
      session.provider as LLMProvider,
      session.provider_session_id ?? session.session_id,
    );

    const deleted = sessionsDb.deleteSessionById(sessionId);
    if (!deleted) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    return {
      sessionId,
      action: 'deleted',
      deletedFromDisk: removedFromDisk || removedFromProvider,
    };
  },

  /**
   * Restores one archived session back into the active sidebar lists.
   */
  restoreSessionById(sessionId: string): { sessionId: string; isArchived: false } {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    sessionsDb.updateSessionIsArchived(sessionId, false);
    return { sessionId, isArchived: false };
  },

  /**
   * Renames one session by id without requiring the caller to pass provider.
   */
  renameSessionById(sessionId: string, summary: string): { sessionId: string; summary: string } {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    sessionsDb.updateSessionCustomName(sessionId, summary);
    return { sessionId, summary };
  },
};
