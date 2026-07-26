import path from 'node:path';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { generateDisplayName } from '@/modules/projects/index.js';
import { ChatSessionWriter } from '@/modules/websocket/services/chat-session-writer.service.js';
import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import type {
  AnyRecord,
  LLMProvider,
  NormalizedMessage,
  RealtimeClientConnection,
} from '@/shared/types.js';

type ChatRunStatus = 'running' | 'completed';

/**
 * One live (or recently finished) provider run for a single app session.
 *
 * State notes — why each mutable field is essential:
 * - `providerSessionId`: the provider-native id captured mid-run. The abort
 *   handler needs it to address the provider runtime, and the DB mapping is
 *   written from it so history/resume work after the run.
 * - `status`: drives `chat_subscribed.isProcessing`, prevents double sends
 *   into the same session, and guards the synthetic-complete fallback in the
 *   chat handler (only emitted when a runtime died without completing).
 * - `lastSeq` / `events`: the per-run event log. Every live event gets a
 *   monotonically increasing `seq` and is buffered so a reconnecting client
 *   can replay exactly the events it missed via `chat.subscribe`.
 */
type ChatRun = {
  appSessionId: string;
  provider: LLMProvider;
  providerSessionId: string | null;
  status: ChatRunStatus;
  lastSeq: number;
  events: NormalizedMessage[];
  writer: ChatSessionWriter;
  startedAt: number;
  completedAt: number | null;
};

/**
 * How long a completed run stays available for replay. Covers the window
 * between a run finishing and the client refreshing history over REST (for
 * example when the browser tab was asleep while the run completed).
 */
const COMPLETED_RUN_RETENTION_MS = 5 * 60 * 1000;

/**
 * Upper bound on buffered events per run so a very long tool-heavy run cannot
 * grow memory unbounded. When exceeded, the oldest events are dropped —
 * a reconnecting client whose `lastSeq` predates the buffer falls back to a
 * REST history refresh, which is always the authoritative source.
 */
const MAX_BUFFERED_EVENTS_PER_RUN = 5000;

/**
 * Active and recently-completed runs keyed by app session id.
 *
 * This map is the single in-memory source of truth for "is something running
 * for this session" — the chat websocket handler, abort path, and subscribe
 * path all consult it instead of asking each provider runtime individually.
 */
const runs = new Map<string, ChatRun>();

/**
 * One message a client queued to send after the session's current run finishes.
 *
 * The queue lives on the server (not per-browser) so it is shared: every client
 * viewing the session sees the same pending list, and the server — not any one
 * browser — drains it when a run completes. `options` carries the full
 * composer-level payload (model, permissionMode, cwd, serialized images, …) so
 * a server-initiated drain can start the run with no client behind it.
 */
export type QueuedMessage = {
  id: string;
  content: string;
  imageCount: number;
  options: AnyRecord;
  userId: string | number | null;
  createdAt: number;
  /**
   * Set once the message has been handed to the provider runtime's own command
   * queue, to be folded into the RUNNING turn (Claude Code behavior) rather
   * than sent as a turn of its own after the run finishes. Such an item is no
   * longer ours to drain — it leaves the queue when the runtime reports it
   * started (or cancelled) — and cancelling it means cancelling it there.
   */
  deliveredUuid?: string | null;
};

/** Why a queued message left the queue without being sent. */
export type QueueRemovalReason = 'cancelled' | 'aborted';

/**
 * A queue item that was dropped rather than delivered. Broadcast alongside the
 * new queue so the client that owns it can put the text back in the composer
 * instead of silently losing it.
 */
export type QueueRemoval = {
  id: string;
  content: string;
  reason: QueueRemovalReason;
};

/** Pending messages per app session id, oldest first. */
const queues = new Map<string, QueuedMessage[]>();

/** Mirror of the client cap so a runaway loop can't grow the queue unbounded. */
const MAX_QUEUED_MESSAGES = 20;

/**
 * Invoked whenever a run's terminal `complete` passes through the registry, so
 * the websocket layer can drain the next queued message. Registered once by the
 * chat websocket service (it owns the provider spawn functions the registry
 * intentionally does not know about).
 */
let onRunCompleteHandler: ((appSessionId: string) => void) | null = null;

/** The client-facing view of a queued item (no server-only bookkeeping). */
function toClientQueued(item: QueuedMessage): {
  id: string;
  content: string;
  imageCount: number;
  createdAt: number;
  delivered: boolean;
} {
  return {
    id: item.id,
    content: item.content,
    imageCount: item.imageCount,
    createdAt: item.createdAt,
    // Drives the queue card's wording: a delivered message goes in at the
    // agent's next step, an undelivered one waits for the whole run.
    delivered: Boolean(item.deliveredUuid),
  };
}

/** Fan the current queue for a session out to every connected client. */
function broadcastQueue(appSessionId: string, removed: QueueRemoval[] = []): void {
  const queue = queues.get(appSessionId) ?? [];
  const payload = JSON.stringify({
    kind: 'queue_updated',
    sessionId: appSessionId,
    queue: queue.map(toClientQueued),
    removed,
    timestamp: new Date().toISOString(),
  });
  connectedClients.forEach((client) => {
    if (client.readyState === WS_OPEN_STATE) {
      client.send(payload);
    }
  });
}

async function broadcastCanonicalSessionUpsert(appSessionId: string): Promise<void> {
  const row = sessionsDb.getSessionById(appSessionId);
  if (!row || row.isArchived) {
    return;
  }

  const projectPath = row.project_path;
  const project = projectPath ? projectsDb.getProjectPath(projectPath) : null;
  const displayName = project?.custom_project_name?.trim()
    ? project.custom_project_name
    : await generateDisplayName(path.basename(projectPath ?? '') || (projectPath ?? ''), projectPath);

  const payload = JSON.stringify({
    kind: 'session_upserted',
    sessionId: row.session_id,
    providerSessionId: row.provider_session_id,
    provider: row.provider,
    session: {
      id: row.session_id,
      summary: row.custom_name || '',
      messageCount: 0,
      lastActivity: row.updated_at ?? row.created_at ?? new Date().toISOString(),
    },
    project: project
      ? {
        projectId: project.project_id,
        path: project.project_path,
        fullPath: project.project_path,
        displayName,
        isStarred: Boolean(project.isStarred),
      }
      : null,
    timestamp: new Date().toISOString(),
  });

  connectedClients.forEach((client) => {
    if (client.readyState === WS_OPEN_STATE) {
      client.send(payload);
    }
  });
}

function evictRunLater(appSessionId: string): void {
  const timer = setTimeout(() => {
    const run = runs.get(appSessionId);
    if (run && run.status === 'completed') {
      runs.delete(appSessionId);
    }
  }, COMPLETED_RUN_RETENTION_MS);

  // Never keep the process alive just to evict a buffered run.
  timer.unref?.();
}

/**
 * Decorates one outbound live event for a run and records it in the event log.
 *
 * Responsibilities:
 * 1. Remap `sessionId` (and `actualSessionId` on `complete`) to the stable
 *    app session id — provider-native ids never leave the backend.
 * 2. Assign the next `seq` so clients can detect/replay gaps.
 * 3. Buffer the event for `chat.subscribe` replay.
 * 4. Flip the run to `completed` when the terminal `complete` event passes by.
 */
function decorateAndRecordEvent(run: ChatRun, message: NormalizedMessage): NormalizedMessage | null {
  // Exactly-one-complete contract: when a run is aborted the chat handler
  // emits the terminal `complete` immediately, but the killed runtime may
  // still emit its own `complete` from its exit handler moments later.
  // Whichever arrives first wins; the duplicate is dropped here.
  if (message.kind === 'complete' && run.status === 'completed') {
    return null;
  }

  run.lastSeq += 1;

  const outbound: NormalizedMessage = {
    ...message,
    sessionId: run.appSessionId,
    seq: run.lastSeq,
  };

  if (message.kind === 'complete') {
    // The provider may report its own id here; the frontend only ever knows
    // the app id, so the "actual" id is by definition the app id as well.
    outbound.actualSessionId = run.appSessionId;
    run.status = 'completed';
    run.completedAt = Date.now();
    evictRunLater(run.appSessionId);
    // Drain the next queued message (if any) once this run has fully settled.
    // Deferred a tick so the terminal `complete` is flushed to clients first,
    // and so the drain's own startRun sees status === 'completed' here.
    if (onRunCompleteHandler) {
      const handler = onRunCompleteHandler;
      const appSessionId = run.appSessionId;
      setTimeout(() => handler(appSessionId), 0);
    }
  }

  run.events.push(outbound);
  if (run.events.length > MAX_BUFFERED_EVENTS_PER_RUN) {
    run.events.splice(0, run.events.length - MAX_BUFFERED_EVENTS_PER_RUN);
  }

  return outbound;
}

/**
 * Records the provider-native session id for a run and persists the
 * app-id-to-provider-id mapping so history fetches and future resumes can
 * address the provider transcript.
 *
 * Called from the gateway writer when the runtime either calls
 * `setSessionId(...)` or emits its `session_created` event — whichever
 * happens first wins; later calls with the same id are no-ops.
 */
function recordProviderSessionId(run: ChatRun, providerSessionId: string): void {
  if (!providerSessionId || run.providerSessionId === providerSessionId) {
    return;
  }

  run.providerSessionId = providerSessionId;

  try {
    sessionsDb.assignProviderSessionId(run.appSessionId, providerSessionId);
    void broadcastCanonicalSessionUpsert(run.appSessionId).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ChatRunRegistry] Failed to broadcast canonical session mapping', {
        appSessionId: run.appSessionId,
        providerSessionId,
        error: message,
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[ChatRunRegistry] Failed to persist provider session id mapping', {
      appSessionId: run.appSessionId,
      providerSessionId,
      error: message,
    });
  }
}

/**
 * Builds a run whose outbound stream fans out to every connected client (no
 * single originating socket) and registers it. Shared by the two
 * server-initiated run kinds — background auto-resume and queue drain. Returns
 * `null` when a run is already active for the session.
 */
function createBroadcastRun(appSessionId: string): ChatRun | null {
  const existing = runs.get(appSessionId);
  if (existing && existing.status === 'running') {
    return null;
  }

  const row = sessionsDb.getSessionById(appSessionId);
  const provider = (row?.provider as LLMProvider) ?? 'claude';
  const providerSessionId = row?.provider_session_id ?? null;

  // The ones viewing this session render the stream, the rest ignore a session
  // id they don't track. A later `chat.subscribe` re-attaches a specific socket
  // (replacing this broadcast) for replay.
  const broadcast = {
    readyState: WS_OPEN_STATE,
    send: (data: string) => {
      connectedClients.forEach((client) => {
        if (client.readyState === WS_OPEN_STATE) {
          client.send(data);
        }
      });
    },
  } as unknown as RealtimeClientConnection;

  const run: ChatRun = {
    appSessionId,
    provider,
    providerSessionId,
    status: 'running',
    lastSeq: 0,
    events: [],
    writer: null as unknown as ChatSessionWriter,
    startedAt: Date.now(),
    completedAt: null,
  };

  run.writer = new ChatSessionWriter({
    connection: broadcast,
    userId: null,
    provider,
    providerSessionId,
    onProviderSessionId: (id) => {
      recordProviderSessionId(run, id);
    },
    decorateOutboundEvent: (message) => decorateAndRecordEvent(run, message),
  });

  runs.set(appSessionId, run);
  return run;
}

/**
 * Registry of live provider runs keyed by the stable app session id.
 *
 * The registry is what makes the websocket protocol provider-independent:
 * every run gets a `ChatSessionWriter` that remaps provider-native session
 * ids to the app id, assigns `seq` numbers, and buffers events for replay —
 * regardless of which provider runtime produced them.
 */
export const chatRunRegistry = {
  /**
   * Starts tracking a run and returns it, or `null` when a run is already in
   * progress for the session (callers must reject the duplicate send).
   */
  startRun(input: {
    appSessionId: string;
    provider: LLMProvider;
    providerSessionId: string | null;
    connection: RealtimeClientConnection;
    userId: string | number | null;
  }): ChatRun | null {
    const existing = runs.get(input.appSessionId);
    if (existing && existing.status === 'running') {
      return null;
    }

    const run: ChatRun = {
      appSessionId: input.appSessionId,
      provider: input.provider,
      providerSessionId: input.providerSessionId,
      status: 'running',
      lastSeq: 0,
      events: [],
      writer: null as unknown as ChatSessionWriter,
      startedAt: Date.now(),
      completedAt: null,
    };

    run.writer = new ChatSessionWriter({
      connection: input.connection,
      userId: input.userId,
      provider: input.provider,
      providerSessionId: input.providerSessionId,
      onProviderSessionId: (providerSessionId) => {
        recordProviderSessionId(run, providerSessionId);
      },
      decorateOutboundEvent: (message) => decorateAndRecordEvent(run, message),
    });

    runs.set(input.appSessionId, run);
    return run;
  },

  /**
   * Opens a server-initiated run for a background auto-resume turn — a turn the
   * agent runs on its own when a `run_in_background` job completes, with no
   * client `chat.send` behind it. Returns the run's writer (whose events
   * broadcast to every connected client, since there is no single originating
   * socket), or `null` when a run is already active for the session (the caller
   * then keeps streaming to the current run instead).
   */
  startResumeRun(appSessionId: string): ChatSessionWriter | null {
    return createBroadcastRun(appSessionId)?.writer ?? null;
  },

  /**
   * Opens a server-initiated run for draining a queued message (see
   * `QueuedMessage`). Like `startResumeRun` there is no originating socket, so
   * events fan out to every connected client; unlike it, the caller then feeds
   * the queued command to the provider runtime against the returned run's
   * writer. Returns `null` when a run is already active (the drain retries on
   * the next completion).
   */
  startQueuedRun(appSessionId: string): ChatRun | null {
    return createBroadcastRun(appSessionId);
  },

  getRun(appSessionId: string): ChatRun | undefined {
    return runs.get(appSessionId);
  },

  isProcessing(appSessionId: string): boolean {
    return runs.get(appSessionId)?.status === 'running';
  },

  listRunningRuns(): Array<{
    sessionId: string;
    provider: LLMProvider;
    startedAt: number;
    lastSeq: number;
  }> {
    return Array.from(runs.values())
      .filter((run) => run.status === 'running')
      .map((run) => ({
        sessionId: run.appSessionId,
        provider: run.provider,
        startedAt: run.startedAt,
        lastSeq: run.lastSeq,
      }));
  },

  /**
   * Re-attaches a run's outbound stream to a (new) websocket connection.
   *
   * This is the generic replacement for the Claude-only writer reconnect:
   * after a page refresh the new socket subscribes and immediately starts
   * receiving the still-running stream, for every provider.
   */
  attachConnection(appSessionId: string, connection: RealtimeClientConnection): boolean {
    const run = runs.get(appSessionId);
    if (!run) {
      return false;
    }

    run.writer.updateWebSocket(connection);
    return true;
  },

  /**
   * Returns buffered events with `seq` greater than `afterSeq` for replay.
   *
   * An empty array with `run.lastSeq > afterSeq` not covered by the buffer
   * means the buffer was truncated; the client should refresh over REST.
   */
  replayEvents(appSessionId: string, afterSeq: number): NormalizedMessage[] {
    const run = runs.get(appSessionId);
    if (!run) {
      return [];
    }

    return run.events.filter((event) => typeof event.seq === 'number' && event.seq > afterSeq);
  },

  /**
   * Emits a synthetic terminal `complete` if (and only if) the run is still
   * marked running. Used when a provider runtime throws or resolves without
   * having produced its own terminal event, and by the abort path.
   */
  completeRun(appSessionId: string, opts: { exitCode: number; aborted?: boolean }): void {
    const run = runs.get(appSessionId);
    if (!run || run.status !== 'running') {
      return;
    }

    run.writer.sendComplete(opts);
  },

  /**
   * Registers the (single) handler the registry calls after any run completes,
   * so the websocket layer can drain the next queued message.
   */
  setRunCompleteHandler(handler: (appSessionId: string) => void): void {
    onRunCompleteHandler = handler;
  },

  /** Client-facing snapshot of the pending queue for a session (for subscribe). */
  getQueueForClient(appSessionId: string): Array<{ id: string; content: string; imageCount: number; createdAt: number }> {
    return (queues.get(appSessionId) ?? []).map(toClientQueued);
  },

  /**
   * Appends a message to a session's queue (deduping by id so a retried add is
   * idempotent) and broadcasts the new queue to all clients. Enforces the cap.
   */
  enqueue(appSessionId: string, item: QueuedMessage): void {
    const queue = queues.get(appSessionId) ?? [];
    if (queue.some((existing) => existing.id === item.id)) {
      return;
    }
    const next = [...queue, item].slice(-MAX_QUEUED_MESSAGES);
    queues.set(appSessionId, next);
    broadcastQueue(appSessionId);
  },

  /**
   * Drops every pending message for a session, reporting each as removed so the
   * client can restore the text. Used by the abort path: Stop has to mean stop,
   * not "stop this and immediately start the next thing I typed".
   */
  clearQueue(appSessionId: string, reason: QueueRemovalReason): void {
    const queue = queues.get(appSessionId);
    if (!queue || queue.length === 0) {
      return;
    }
    queues.delete(appSessionId);
    broadcastQueue(
      appSessionId,
      queue.map((item) => ({ id: item.id, content: item.content, reason })),
    );
  },

  /** Re-broadcasts the queue unchanged (to correct an optimistic client). */
  touchQueue(appSessionId: string): void {
    broadcastQueue(appSessionId);
  },

  /** Looks up one queued message by id without removing it. */
  getQueued(appSessionId: string, id: string): QueuedMessage | null {
    return (queues.get(appSessionId) ?? []).find((item) => item.id === id) ?? null;
  },

  /**
   * Records that the provider runtime took ownership of a queued message (it
   * will be folded into the running turn), and re-broadcasts so clients relabel
   * the card. The item stays in the queue — visible as pending — until the
   * runtime reports it started.
   */
  markDelivered(appSessionId: string, id: string, deliveredUuid: string): void {
    const item = (queues.get(appSessionId) ?? []).find((entry) => entry.id === id);
    if (!item) {
      return;
    }
    item.deliveredUuid = deliveredUuid;
    broadcastQueue(appSessionId);
  },

  /**
   * Removes one queued message by id and broadcasts the change. `reason`
   * marks it as dropped rather than sent, so the client can restore the text
   * into the composer; omit it when the message is on its way to the model.
   */
  removeQueued(appSessionId: string, id: string, reason?: QueueRemovalReason): QueuedMessage | null {
    const queue = queues.get(appSessionId);
    if (!queue) {
      return null;
    }
    const removed = queue.find((item) => item.id === id) ?? null;
    const next = queue.filter((item) => item.id !== id);
    if (next.length === queue.length) {
      return null;
    }
    if (next.length === 0) {
      queues.delete(appSessionId);
    } else {
      queues.set(appSessionId, next);
    }
    broadcastQueue(
      appSessionId,
      reason && removed ? [{ id: removed.id, content: removed.content, reason }] : [],
    );
    return removed;
  },

  /**
   * Pops the oldest message the server still owns (broadcasting the removal),
   * or null. Messages already handed to the provider runtime are skipped —
   * draining one would send its content a second time.
   */
  dequeueNext(appSessionId: string): QueuedMessage | null {
    const queue = queues.get(appSessionId);
    if (!queue || queue.length === 0) {
      return null;
    }
    const index = queue.findIndex((item) => !item.deliveredUuid);
    if (index === -1) {
      return null;
    }
    const next = queue[index];
    const rest = queue.filter((_, position) => position !== index);
    if (rest.length === 0) {
      queues.delete(appSessionId);
    } else {
      queues.set(appSessionId, rest);
    }
    broadcastQueue(appSessionId);
    return next;
  },

  /**
   * Puts a message back at the front of the queue — used when a drain loses the
   * race to another run and must retry the item on the next completion.
   */
  requeueFront(appSessionId: string, item: QueuedMessage): void {
    const queue = queues.get(appSessionId) ?? [];
    queues.set(appSessionId, [item, ...queue].slice(0, MAX_QUEUED_MESSAGES));
    broadcastQueue(appSessionId);
  },

  /** True when a message is waiting for the server to send it as its own turn. */
  hasQueued(appSessionId: string): boolean {
    return (queues.get(appSessionId) ?? []).some((item) => !item.deliveredUuid);
  },

  /**
   * Safety-net variant of `completeRun` scoped to one specific run: a no-op
   * unless `run` is still the session's current, running run. A runtime
   * promise can resolve after its own `complete` already streamed AND a new
   * run has replaced it in the registry (a queued message sends within
   * milliseconds of the previous turn ending) — the session-keyed
   * `completeRun` would terminate that newer run.
   */
  completeRunIfCurrent(run: ChatRun, opts: { exitCode: number; aborted?: boolean }): void {
    if (runs.get(run.appSessionId) !== run || run.status !== 'running') {
      return;
    }

    run.writer.sendComplete(opts);
  },

  /**
   * Test-only escape hatch: clears every tracked run and queue.
   */
  clearAll(): void {
    runs.clear();
    queues.clear();
  },
};
