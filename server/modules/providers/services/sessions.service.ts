import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { broadcastSessionUpdate } from '@/modules/providers/services/sessions-watcher.service.js';
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
};

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
   * this row later, when the provider runtime announces it mid-run.
   *
   * `isSide` allocates the session for a `/btw` question instead: identical in
   * every way, but kept out of the session lists until it is promoted.
   */
  createAppSession(
    provider: LLMProvider,
    projectPath: string,
    isSide = false,
  ): CreateAppSessionResult {
    const normalizedProjectPath = projectPath.trim();
    if (!normalizedProjectPath) {
      throw new AppError('projectPath is required.', {
        code: 'PROJECT_PATH_REQUIRED',
        statusCode: 400,
      });
    }

    const sessionId = randomUUID();
    sessionsDb.createAppSession(sessionId, provider, normalizedProjectPath, isSide);

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
    };
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
        if (row) {
          sessionsDb.deleteSessionById(row.session_id);
        }
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
   * Returns archived sessions with enough project metadata for the sidebar to
   * group, filter, open, and restore them without a per-row follow-up query.
   */
  listArchivedSessions(): ArchivedSessionListItem[] {
    const archivedSessions = sessionsDb.getArchivedSessions();
    const projectCache = new Map<string, ReturnType<typeof projectsDb.getProjectPath>>();

    return archivedSessions.map((session) => {
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
        projectPath,
        projectDisplayName: resolveProjectDisplayName(projectPath, project?.custom_project_name),
        sessionTitle: session.custom_name?.trim() || session.session_id,
        createdAt: session.created_at ?? null,
        updatedAt: session.updated_at ?? null,
        lastActivity: session.updated_at ?? session.created_at ?? null,
        isProjectArchived: Boolean(project?.isArchived),
      };
    });
  },

  /**
   * Archives or permanently deletes one persisted session row by id.
   *
   * Soft-delete mirrors the project behavior by toggling `isArchived` so the
   * row disappears from active lists but remains restorable. Force-delete
   * optionally removes the transcript file before deleting the database row.
   */
  async deleteOrArchiveSessionById(
    sessionId: string,
    options: {
      force?: boolean;
      deletedFromDisk?: boolean;
    } = {},
  ): Promise<{ sessionId: string; action: 'archived' | 'deleted'; deletedFromDisk: boolean }> {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
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
