import path from 'node:path';

import type { WebSocket } from 'ws';

import { sessionsDb } from '@/modules/database/index.js';
import { providerModelsService } from '@/modules/providers/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import {
  subscribeProjectFiles,
  unsubscribeProjectFiles,
  unsubscribeAllProjectFiles,
  subscribeFilePath,
  unsubscribeFilePath,
  unsubscribeAllFilePaths,
} from '@/modules/websocket/services/project-files-watcher.service.js';
import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import {
  getGlobalImageAssetsDir,
  isImageAttachmentDescriptor,
  normalizeAttachmentDescriptors,
  type ChatAttachmentDescriptor,
} from '@/shared/image-attachments.js';
import type {
  AnyRecord,
  AuthenticatedWebSocketRequest,
  LLMProvider,
  ProviderPermissionDecision,
  ProviderRuntimeWriter,
} from '@/shared/types.js';
import { createNormalizedMessage, parseIncomingJsonObject } from '@/shared/utils.js';

/**
 * Trust boundary for client-supplied image attachments: chat.send options come
 * straight from the browser, and the provider runtimes read the referenced
 * files off disk (Claude base64-encodes them into the prompt). Only images
 * that live directly inside the global upload store (`~/.vibespace/assets`,
 * where POST /api/assets/images puts them) are allowed through — anything
 * else (absolute paths elsewhere, traversal, subdirectories) is dropped.
 *
 * Exported for tests; `assetsRootOverride` exists only for them.
 */
export function filterAttachmentsToUploadStore(
  attachments: unknown,
  assetsRootOverride?: string,
): ChatAttachmentDescriptor[] {
  const assetsRoot = path.resolve(assetsRootOverride ?? getGlobalImageAssetsDir());

  return normalizeAttachmentDescriptors(attachments).filter((descriptor) => {
    // Relative paths are anchored in the store; absolute ones must already be in it.
    const resolved = path.resolve(assetsRoot, descriptor.path);
    const relative = path.relative(assetsRoot, resolved);
    const isDirectChild =
      relative.length > 0 &&
      !relative.startsWith('..') &&
      !path.isAbsolute(relative) &&
      !relative.includes(path.sep) &&
      !relative.includes('/');

    if (!isDirectChild) {
      console.warn(`[Chat] Dropping attachment outside the upload store: ${descriptor.path}`);
    }
    return isDirectChild;
  });
}

/** Backward-compatible image filter consumed by existing websocket tests. */
export function filterImagesToUploadStore(
  images: unknown,
  assetsRootOverride?: string,
): ChatAttachmentDescriptor[] {
  return filterAttachmentsToUploadStore(images, assetsRootOverride);
}

/** Application boundary for dispatching provider runs and approvals. */
type ProviderRuntimeGateway = {
  hasRuntime(provider: string): boolean;
  run(
    provider: LLMProvider,
    command: string,
    options: AnyRecord,
    writer: ProviderRuntimeWriter,
  ): Promise<unknown>;
  abort(provider: LLMProvider, sessionId: string): Promise<boolean>;
  resolveToolApproval(requestId: string, payload: ProviderPermissionDecision): void;
  getPendingApprovalsForSession(sessionId: string): unknown[];
};

type ChatWebSocketDependencies = {
  /** Central dispatcher for every provider SDK/CLI runtime (run/abort/approvals). */
  runtime: ProviderRuntimeGateway;
  /**
   * Per-background-job cancel, keyed by provider id. Only providers with a
   * task-level stop are present (Claude today); a missing entry means the
   * provider has no such capability and the request no-ops. Addressed with the
   * provider-native session id (the persistent session's own key).
   */
  stopTaskFns?: Partial<Record<LLMProvider, (providerSessionId: string, taskId: string) => boolean | Promise<boolean>>>;
  /**
   * Mid-turn message delivery, keyed by provider id. A runtime that has one
   * accepts a user message while a turn is running and folds it into that turn
   * at the agent's next step, the way the Claude Code CLI does — instead of the
   * message waiting for the whole run to finish. Resolves the runtime-side id
   * the message is cancellable by, or null when it could not be delivered
   * (no live session), which falls back to the app-level queue.
   */
  injectFns?: Partial<Record<LLMProvider, (
    providerSessionId: string,
    content: string,
    options: AnyRecord,
  ) => Promise<string | null>>>;
  /**
   * Cancels a message previously handed to a runtime via `injectFns`. Resolves
   * false when the runtime had already started it — its content is running, so
   * the caller must not treat it as recalled.
   */
  cancelInjectedFns?: Partial<Record<LLMProvider, (
    providerSessionId: string,
    injectedUuid: string,
  ) => Promise<boolean>>>;
};

/**
 * Extracts the authenticated request user id in the formats currently produced
 * by platform and OSS auth code paths.
 */
function readRequestUserId(
  request: AuthenticatedWebSocketRequest | undefined
): string | number | null {
  const user = request?.user;
  if (!user) {
    return null;
  }

  if (typeof user.id === 'string' || typeof user.id === 'number') {
    return user.id;
  }

  if (typeof user.userId === 'string' || typeof user.userId === 'number') {
    return user.userId;
  }

  return null;
}

function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WS_OPEN_STATE) {
    ws.send(JSON.stringify(payload));
  }
}

/**
 * Client message ids of recently accepted `chat.send` frames, per app session.
 *
 * A send is acked over the very socket it arrived on. When that socket dies in
 * between — a proxy restart drops the connection while the frame is already
 * being handled — the ack is written into a closed socket and the client, which
 * has no receipt, re-sends the message on reconnect. Without a memory of what
 * was already accepted that resend starts a second run for the same text (or is
 * bounced as RUN_IN_PROGRESS and re-queued, which delivers it twice).
 *
 * Bounded per session and swept by age: this only has to outlive a reconnect,
 * not the session.
 */
const acceptedSends = new Map<string, Map<string, number>>();
const ACCEPTED_SEND_TTL_MS = 10 * 60 * 1000;
const MAX_ACCEPTED_SENDS_PER_SESSION = 50;

function wasSendAccepted(sessionId: string, clientMsgId: string): boolean {
  const accepted = acceptedSends.get(sessionId);
  if (!accepted) {
    return false;
  }
  const at = accepted.get(clientMsgId);
  if (at === undefined) {
    return false;
  }
  if (Date.now() - at > ACCEPTED_SEND_TTL_MS) {
    accepted.delete(clientMsgId);
    return false;
  }
  return true;
}

function rememberAcceptedSend(sessionId: string, clientMsgId: string): void {
  let accepted = acceptedSends.get(sessionId);
  if (!accepted) {
    accepted = new Map<string, number>();
    acceptedSends.set(sessionId, accepted);
  }

  const now = Date.now();
  accepted.set(clientMsgId, now);

  for (const [id, at] of accepted) {
    if (now - at > ACCEPTED_SEND_TTL_MS) {
      accepted.delete(id);
    }
  }
  // Insertion order is oldest-first, so the excess is taken off the front.
  while (accepted.size > MAX_ACCEPTED_SENDS_PER_SESSION) {
    const oldest = accepted.keys().next();
    if (oldest.done) {
      break;
    }
    accepted.delete(oldest.value);
  }
}

/**
 * Reports a protocol-level failure to the requesting client.
 *
 * Protocol errors deliberately use their own `kind` (instead of the provider
 * `error` message kind) so the frontend can distinguish "your request was
 * invalid" from "the model run produced an error" without inspecting text.
 */
function sendProtocolError(
  ws: WebSocket,
  code: string,
  error: string,
  sessionId?: string
): void {
  // Server-side trace for rejected client requests — without it a rejected
  // send is invisible in the daemon log (the error only goes to the browser).
  console.warn(`[Chat] Protocol error ${code}${sessionId ? ` (session ${sessionId})` : ''}: ${error}`);
  sendJson(ws, {
    kind: 'protocol_error',
    code,
    error,
    sessionId: sessionId ?? null,
    timestamp: new Date().toISOString(),
  });
}

function readRequiredSessionId(data: AnyRecord): string | null {
  const sessionId = typeof data.sessionId === 'string' ? data.sessionId.trim() : '';
  return sessionId.length > 0 ? sessionId : null;
}

type SessionRow = NonNullable<ReturnType<typeof sessionsDb.getSessionById>>;

/**
 * Builds the provider runtime options for a turn from the session row and the
 * composer-level client options. The session row (not the client) is the source
 * of truth for provider, project path, and the provider-native resume id; the
 * client only contributes composer preferences (model, permissionMode, cwd,
 * images, …). Shared by the live `chat.send` path and the server-initiated
 * queue drain so both start runs identically.
 */
function buildRuntimeOptions(
  session: SessionRow,
  clientOptions: AnyRecord,
  provider: LLMProvider,
  appSessionId: string,
): AnyRecord {
  const attachmentCandidates = [
    ...normalizeAttachmentDescriptors(clientOptions.images),
    ...normalizeAttachmentDescriptors(clientOptions.files),
    ...normalizeAttachmentDescriptors(clientOptions.attachments),
  ];
  const verifiedAttachments = filterAttachmentsToUploadStore(attachmentCandidates);
  const uniqueAttachments = verifiedAttachments.filter(
    (descriptor, index, all) => all.findIndex((candidate) => candidate.path === descriptor.path) === index,
  );

  // The provider runtimes receive the stable app session id. When their
  // CLI/SDK needs the provider-native id for resume, they resolve it from the
  // session row themselves (ProviderRuntimeContext.resolveProviderSessionId).
  // Brand-new sessions have no provider id yet, so the runtime starts fresh
  // and announces one, which the gateway writer captures and maps back to the
  // app session id. `providerSessionId`/`resume` are carried alongside as the
  // already-resolved answer for runtimes that read them from options.
  const runtimeOptions: AnyRecord = {
    ...clientOptions,
    // Attachments are re-validated server-side: only direct children of the
    // global upload store may reach provider runtimes or their file tools.
    attachments: uniqueAttachments,
    images: uniqueAttachments.filter(isImageAttachmentDescriptor),
    files: uniqueAttachments.filter((descriptor) => !isImageAttachmentDescriptor(descriptor)),
    sessionId: appSessionId,
    providerSessionId: session.provider_session_id ?? undefined,
    resume: Boolean(session.provider_session_id),
    // The client sends `cwd` explicitly; the session's project path is the
    // headless fallback (background-job resume, a server-drained queued
    // message with no client behind it). A worktree is its own project.
    cwd: clientOptions.cwd ?? session.project_path ?? undefined,
    projectPath: session.project_path ?? clientOptions.projectPath,
    // Private is a property of the row, never of the client request: each
    // runtime puts the private-variant env (see collectAgentEnv) into the harness process it spawns for this
    // turn, so no presence reporter ever speaks for the session.
    private: Boolean(session.is_private),
  };

  // Claude background-job auto-resume: when a `run_in_background` job finishes
  // after its turn, the persistent session opens its OWN run for the resumed
  // turn (server-initiated, no client send) so its output is sequenced/replayed
  // and the session shows as processing again.
  if (provider === 'claude') {
    runtimeOptions.acquireResumeRun = () => chatRunRegistry.startResumeRun(appSessionId);
  }

  return runtimeOptions;
}

/**
 * Records what a turn runs with so reopening the session later restores the
 * same model and reasoning effort, and so the resume path has a
 * session-scoped model answer to use. Called for live sends and for
 * server-drained queued messages alike (a queued message carries the composer
 * options it was written with).
 */
function recordSessionPreferences(provider: LLMProvider, sessionId: string, clientOptions: AnyRecord): void {
  if (typeof clientOptions.model === 'string' && clientOptions.model.trim()) {
    providerModelsService.setSessionModel(provider, sessionId, clientOptions.model);
  }
  if (typeof clientOptions.effort === 'string' && clientOptions.effort.trim()) {
    providerModelsService.setSessionEffort(provider, sessionId, clientOptions.effort);
  }
}

/**
 * Sends the next queued message for a session, if any, once its run has
 * finished. The server (not any single browser) owns draining so the shared
 * queue works across clients: this fires from the registry's run-complete
 * handler and, recursively, from each drained run's own completion — chaining
 * until the queue empties.
 */
async function drainQueue(appSessionId: string): Promise<void> {
  const dependencies = drainDependencies;
  if (!dependencies) {
    return;
  }
  // A run may already be active (e.g. a background auto-resume beat us to it);
  // the next completion re-fires this drain.
  if (chatRunRegistry.isProcessing(appSessionId) || !chatRunRegistry.hasQueued(appSessionId)) {
    return;
  }

  const item = chatRunRegistry.dequeueNext(appSessionId);
  if (!item) {
    return;
  }

  const session = sessionsDb.getSessionById(appSessionId);
  const provider = session?.provider as LLMProvider | undefined;
  if (!session || !provider || !dependencies.runtime.hasRuntime(provider)) {
    // Session or provider vanished — drop the item (it can't be delivered).
    return;
  }

  const run = chatRunRegistry.startQueuedRun(appSessionId);
  if (!run) {
    // Lost the race to another run; retry this item on the next completion.
    chatRunRegistry.requeueFront(appSessionId, item);
    return;
  }

  const clientOptions = (item.options ?? {}) as AnyRecord;
  recordSessionPreferences(provider, appSessionId, clientOptions);
  const runtimeOptions = buildRuntimeOptions(session, clientOptions, provider, appSessionId);
  // Notifications for a server-drained turn route through the writer's user:
  // the one who queued the message, or the supervisor that enqueued on their
  // behalf (restore / usage-limit wake).
  run.writer.userId = item.userId ?? null;

  // Emit the queued prompt as a live user message so its bubble shows for every
  // client (the normal send path adds this optimistically on the sending
  // browser; a server-drained turn has no browser behind it). It is transient —
  // the authoritative copy is the provider transcript, which replaces this on
  // the next history load, so there is no lasting duplicate.
  if (item.content.trim()) {
    const retryMessageId = typeof item.options?.rateLimitWakeMessageId === 'string'
      ? item.options.rateLimitWakeMessageId
      : '';
    run.writer.send(
      createNormalizedMessage({
        ...(retryMessageId ? { id: `vibespace_retry_${retryMessageId}` } : {}),
        kind: 'text',
        role: 'user',
        content: item.content,
        provider,
        sessionId: appSessionId,
      }),
    );
  }

  try {
    await dependencies.runtime.run(provider, item.content, runtimeOptions, run.writer);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Chat] Queued run for provider "${provider}" failed`, { sessionId: appSessionId, error: message });
  } finally {
    // Terminal complete flips the run to completed and re-fires the drain for
    // the next queued item (if any).
    chatRunRegistry.completeRun(appSessionId, { exitCode: 1 });
  }
}

/**
 * The chat dependencies captured for server-initiated queue draining. Set once
 * (the object is stable across connections) so the registry's run-complete
 * handler — which has no dependencies of its own — can spawn provider runtimes.
 */
let drainDependencies: ChatWebSocketDependencies | null = null;
let drainHandlerRegistered = false;

function ensureQueueDrainingRegistered(dependencies: ChatWebSocketDependencies): void {
  drainDependencies = dependencies;
  if (drainHandlerRegistered) {
    return;
  }
  drainHandlerRegistered = true;
  chatRunRegistry.setRunCompleteHandler((appSessionId) => {
    void drainQueue(appSessionId);
  });
}

/**
 * Handles `chat.send`: resolves the session row (provider, project path, and
 * provider-native id all come from the database — never from the client),
 * registers the run, and dispatches to the provider runtime.
 */
async function handleChatSend(
  ws: WebSocket,
  userId: string | number | null,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): Promise<void> {
  const sessionId = readRequiredSessionId(data);
  if (!sessionId) {
    sendProtocolError(ws, 'SESSION_ID_REQUIRED', 'chat.send requires a sessionId.');
    return;
  }

  const session = sessionsDb.getSessionById(sessionId);
  if (!session) {
    sendProtocolError(
      ws,
      'SESSION_NOT_FOUND',
      `Session "${sessionId}" was not found. Create it via POST /api/providers/sessions first.`,
      sessionId
    );
    return;
  }

  // A resend of something already accepted (the client's ack died with its
  // socket). Re-ack it and stop — checked before `startRun` so the duplicate
  // can neither open a second run nor be bounced as RUN_IN_PROGRESS, which the
  // client would answer by queueing the same message a second time.
  const clientMsgId = typeof data.clientMsgId === 'string' ? data.clientMsgId : '';
  if (clientMsgId && wasSendAccepted(sessionId, clientMsgId)) {
    sendJson(ws, {
      kind: 'send_ack',
      sessionId,
      clientMsgId,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  const provider = session.provider as LLMProvider;
  if (!dependencies.runtime.hasRuntime(provider)) {
    sendProtocolError(ws, 'UNSUPPORTED_PROVIDER', `Provider "${provider}" is not available.`, sessionId);
    return;
  }

  const run = chatRunRegistry.startRun({
    appSessionId: sessionId,
    provider,
    providerSessionId: session.provider_session_id,
    connection: ws,
    userId,
  });

  if (!run) {
    sendProtocolError(
      ws,
      'RUN_IN_PROGRESS',
      `Session "${sessionId}" already has a run in progress.`,
      sessionId
    );
    return;
  }

  // Explicit receipt for the composer's pending-send journal. The client
  // journals every dispatched send and restores unacked entries into the
  // input; without an id-correlated ack it can only guess from live run
  // events, and replayed events from a previous run falsely ack a send that
  // never arrived. Sent after the run is registered, so the ack means "this
  // exact frame was accepted and a run started for it".
  //
  // Recorded before the ack is written: if the socket is already gone the ack
  // goes nowhere, and the record is what lets the client's resend be
  // recognised instead of run twice.
  if (clientMsgId) {
    rememberAcceptedSend(sessionId, clientMsgId);
    sendJson(ws, {
      kind: 'send_ack',
      sessionId,
      clientMsgId,
      timestamp: new Date().toISOString(),
    });
  }

  const clientOptions = (data.options ?? {}) as AnyRecord;
  const command = typeof data.content === 'string' ? data.content : '';

  recordSessionPreferences(provider, sessionId, clientOptions);
  const runtimeOptions = buildRuntimeOptions(session, clientOptions, provider, sessionId);

  try {
    await dependencies.runtime.run(provider, command, runtimeOptions, run.writer);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Chat] Provider runtime "${provider}" failed`, { sessionId, error: message });
  } finally {
    // Safety net: a runtime that crashed (or resolved) without emitting its
    // terminal `complete` would otherwise leave the session stuck in
    // "processing" forever on every connected client. Scoped to THIS run —
    // a queued message can start the session's next run before this promise
    // settles, and the session-keyed completeRun would kill that new run.
    chatRunRegistry.completeRunIfCurrent(run, { exitCode: 1 });
  }
}

/**
 * Handles `chat.abort`: cancels the run for one app session and emits the
 * terminal `complete` on its behalf (runtimes skip their own complete for
 * aborted runs, and the registry drops any duplicate).
 */
async function handleChatAbort(
  ws: WebSocket,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): Promise<void> {
  const sessionId = readRequiredSessionId(data);
  if (!sessionId) {
    sendProtocolError(ws, 'SESSION_ID_REQUIRED', 'chat.abort requires a sessionId.');
    return;
  }

  const run = chatRunRegistry.getRun(sessionId);
  if (!run || run.status !== 'running') {
    sendProtocolError(ws, 'NO_ACTIVE_RUN', `Session "${sessionId}" has no active run.`, sessionId);
    return;
  }

  const success = await dependencies.runtime.abort(run.provider, sessionId);

  // Stop stops everything the user has lined up, not just the current turn:
  // without this the terminal `complete` below would immediately drain the
  // queue and start a new run from the message they queued during the one they
  // just stopped. Each dropped message's text goes back to the composer.
  // (Messages the runtime already holds are cancelled inside the abort above,
  // which removes them the same way.)
  chatRunRegistry.clearQueue(sessionId, 'aborted');

  chatRunRegistry.completeRun(sessionId, {
    exitCode: success ? 0 : 1,
    aborted: true,
  });
}

/**
 * Handles `chat.stop-task`: cancels a single background bash job by its task id
 * without ending the turn or the session. Unlike `chat.abort`, this does not
 * require a *running* turn — background jobs routinely outlive their launching
 * turn, so we address the persistent session directly by its provider id.
 */
async function handleChatStopTask(
  ws: WebSocket,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): Promise<void> {
  const sessionId = readRequiredSessionId(data);
  if (!sessionId) {
    sendProtocolError(ws, 'SESSION_ID_REQUIRED', 'chat.stop-task requires a sessionId.');
    return;
  }

  const taskId = typeof data.taskId === 'string' ? data.taskId.trim() : '';
  if (!taskId) {
    sendProtocolError(ws, 'TASK_ID_REQUIRED', 'chat.stop-task requires a taskId.', sessionId);
    return;
  }

  const session = sessionsDb.getSessionById(sessionId);
  if (!session) {
    sendProtocolError(ws, 'SESSION_NOT_FOUND', `Session "${sessionId}" was not found.`, sessionId);
    return;
  }

  const provider = session.provider as LLMProvider;
  const stopFn = dependencies.stopTaskFns?.[provider];
  // The persistent session is keyed by its provider-native id; fall back to a
  // live run's captured id, then the DB mapping.
  const providerSessionId =
    chatRunRegistry.getRun(sessionId)?.providerSessionId ?? session.provider_session_id ?? null;

  if (!stopFn || !providerSessionId) {
    sendProtocolError(
      ws,
      'STOP_TASK_UNSUPPORTED',
      `Cannot stop background tasks for provider "${provider}".`,
      sessionId,
    );
    return;
  }

  await stopFn(providerSessionId, taskId);
}

/**
 * Resolves the provider-native id for a session: a live run's captured id wins
 * (a brand-new session has none in the database yet), then the DB mapping.
 */
function resolveProviderSessionId(appSessionId: string, session: SessionRow): string | null {
  return chatRunRegistry.getRun(appSessionId)?.providerSessionId ?? session.provider_session_id ?? null;
}

/**
 * Hands a queued message to the provider runtime so it lands in the RUNNING
 * turn at the agent's next step instead of waiting for the whole run — what
 * the Claude Code CLI does with a message typed mid-task.
 *
 * The item stays in the shared queue (so every client still sees it pending)
 * until the runtime reports it started, at which point the runtime's own
 * stream carries the user bubble. Returns false when the runtime can't take it
 * and the server-drained queue remains responsible for it.
 */
async function tryDeliverToRunningTurn(
  appSessionId: string,
  session: SessionRow,
  provider: LLMProvider,
  item: { id: string; content: string; options: AnyRecord },
  dependencies: ChatWebSocketDependencies,
): Promise<boolean> {
  const injectFn = dependencies.injectFns?.[provider];
  const providerSessionId = resolveProviderSessionId(appSessionId, session);
  if (!injectFn || !providerSessionId || !chatRunRegistry.isProcessing(appSessionId)) {
    return false;
  }

  const runtimeOptions = buildRuntimeOptions(session, item.options ?? {}, provider, appSessionId);

  try {
    const injectedUuid = await injectFn(providerSessionId, item.content, {
      ...runtimeOptions,
      clientUserMessageId: item.id,
      // Delivered: the runtime now owns the message and streams the bubble.
      onDelivered: () => chatRunRegistry.removeQueued(appSessionId, item.id),
      // Cancelled (Stop pressed): hand the text back to the composer.
      onCancelled: () => chatRunRegistry.removeQueued(appSessionId, item.id, 'aborted'),
    });
    if (!injectedUuid) {
      return false;
    }
    chatRunRegistry.markDelivered(appSessionId, item.id, injectedUuid);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[Chat] Mid-turn delivery failed for session ${appSessionId}`, { error: message });
    return false;
  }
}

/**
 * Handles `chat.queue-add`: appends a message to the session's server-owned
 * queue so it is shared across every client viewing the session.
 *
 * Delivery then takes whichever path the provider supports: runtimes that
 * accept mid-turn messages get it right away (it joins the running turn at the
 * agent's next step); otherwise it waits in the queue and the server sends it
 * as its own turn once the run finishes. If the session is idle when the add
 * arrives (a race — the run finished between the client deciding to queue and
 * this message landing), the drain fires immediately.
 */
async function handleChatQueueAdd(
  ws: WebSocket,
  userId: string | number | null,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies,
): Promise<void> {
  const sessionId = readRequiredSessionId(data);
  if (!sessionId) {
    sendProtocolError(ws, 'SESSION_ID_REQUIRED', 'chat.queue-add requires a sessionId.');
    return;
  }

  const session = sessionsDb.getSessionById(sessionId);
  if (!session) {
    sendProtocolError(ws, 'SESSION_NOT_FOUND', `Session "${sessionId}" was not found.`, sessionId);
    return;
  }

  const content = typeof data.content === 'string' ? data.content : '';
  const options = (data.options ?? {}) as AnyRecord;
  const images = Array.isArray(options.images) ? options.images : [];
  if (!content.trim() && images.length === 0) {
    return;
  }

  const id = typeof data.id === 'string' && data.id.trim()
    ? data.id.trim()
    : `queued_${Date.now()}_${Math.round(Math.random() * 1e9).toString(36)}`;

  chatRunRegistry.enqueue(sessionId, {
    id,
    content,
    imageCount: images.length,
    options,
    userId,
    createdAt: Date.now(),
  });

  const provider = session.provider as LLMProvider;
  const delivered = await tryDeliverToRunningTurn(
    sessionId,
    session,
    provider,
    { id, content, options },
    dependencies,
  );

  if (!delivered && !chatRunRegistry.isProcessing(sessionId)) {
    void drainQueue(sessionId);
  }
}

/**
 * Handles `chat.queue-remove`: drops one pending message from the shared queue.
 *
 * A message already handed to the provider runtime has to be recalled there
 * first; if the runtime has started it, the content is on its way to the model
 * and the item stays put (the client learns this by not seeing it removed).
 */
async function handleChatQueueRemove(
  ws: WebSocket,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies,
): Promise<void> {
  const sessionId = readRequiredSessionId(data);
  if (!sessionId) {
    sendProtocolError(ws, 'SESSION_ID_REQUIRED', 'chat.queue-remove requires a sessionId.');
    return;
  }
  const id = typeof data.id === 'string' ? data.id.trim() : '';
  if (!id) {
    sendProtocolError(ws, 'QUEUE_ID_REQUIRED', 'chat.queue-remove requires an id.', sessionId);
    return;
  }

  const queued = chatRunRegistry.getQueued(sessionId, id);
  if (queued?.deliveredUuid) {
    const session = sessionsDb.getSessionById(sessionId);
    const provider = session?.provider as LLMProvider | undefined;
    const cancelFn = provider ? dependencies.cancelInjectedFns?.[provider] : undefined;
    const providerSessionId = session ? resolveProviderSessionId(sessionId, session) : null;
    const cancelled = cancelFn && providerSessionId
      ? await cancelFn(providerSessionId, queued.deliveredUuid)
      : false;
    if (!cancelled) {
      // Too late — it is running. Re-broadcast so the client that optimistically
      // hid the card puts it back.
      chatRunRegistry.touchQueue(sessionId);
      return;
    }
  }

  chatRunRegistry.removeQueued(sessionId, id, 'cancelled');
}

/**
 * Handles `chat.subscribe`: for each requested session, reports whether a run
 * is processing, re-attaches the live stream to this socket, replays missed
 * events (seq > lastSeq), and includes pending permission requests.
 *
 * This single message replaces the old `check-session-status`,
 * `get-pending-permissions`, and Claude-only writer reconnect flows.
 */
function handleChatSubscribe(
  ws: WebSocket,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): void {
  const targets = Array.isArray(data.sessions) ? data.sessions : [];

  for (const target of targets) {
    if (!target || typeof target !== 'object') {
      continue;
    }

    const sessionId = typeof (target as AnyRecord).sessionId === 'string'
      ? ((target as AnyRecord).sessionId as string).trim()
      : '';
    if (!sessionId) {
      continue;
    }

    const lastSeqRaw = (target as AnyRecord).lastSeq;
    const lastSeq = typeof lastSeqRaw === 'number' && Number.isFinite(lastSeqRaw)
      ? Math.max(0, Math.floor(lastSeqRaw))
      : 0;

    const run = chatRunRegistry.getRun(sessionId);
    const isProcessing = chatRunRegistry.isProcessing(sessionId);

    // Future live events for this run should land on the socket that asked —
    // this is what makes mid-stream page refreshes work for all providers.
    if (isProcessing) {
      chatRunRegistry.attachConnection(sessionId, ws);
    }

    // Pending approvals are tracked under the app session id inside the
    // Claude runtime, so they can be looked up directly.
    const pendingPermissions = dependencies.runtime.getPendingApprovalsForSession(sessionId);

    sendJson(ws, {
      kind: 'chat_subscribed',
      sessionId,
      isProcessing,
      lastSeq: run?.lastSeq ?? 0,
      pendingPermissions,
      // Server-owned message queue snapshot so a freshly-opened client sees any
      // messages another browser queued for this session.
      queue: chatRunRegistry.getQueueForClient(sessionId),
      timestamp: new Date().toISOString(),
    });

    // Replay only for RUNNING runs, strictly after the ack. Completed runs
    // are fully persisted to the provider transcript and served over REST —
    // replaying them (e.g. after a page reload where the client's lastSeq is
    // 0) would duplicate messages the history fetch already returned.
    if (isProcessing) {
      for (const event of chatRunRegistry.replayEvents(sessionId, lastSeq)) {
        sendJson(ws, event);
      }
    }
  }
}

/**
 * Handles `chat.permission-response`: forwards a tool-approval decision to the
 * pending approval resolver (Claude is the only provider with interactive
 * approvals today, but the message is intentionally provider-neutral).
 */
function handlePermissionResponse(data: AnyRecord, dependencies: ChatWebSocketDependencies): void {
  if (typeof data.requestId !== 'string' || data.requestId.length === 0) {
    return;
  }

  // `permissionMode` is our extension of the shared decision shape (see
  // ProviderPermissionDecision in @/shared/types.ts).
  const decision: ProviderPermissionDecision & { permissionMode?: string } = {
    allow: Boolean(data.allow),
    updatedInput: data.updatedInput,
    message: typeof data.message === 'string' ? data.message : undefined,
    rememberEntry: data.rememberEntry,
    // Carried only by an ExitPlanMode approval: the mode the session should run
    // in now that plan mode is over. Without it the runtime falls back to
    // `default` and ignores a bypassPermissions the user had already selected.
    permissionMode: typeof data.permissionMode === 'string' ? data.permissionMode : undefined,
  };
  dependencies.runtime.resolveToolApproval(data.requestId, decision);
}

function readProjectId(data: AnyRecord): string | null {
  const projectId = typeof data.projectId === 'string' ? data.projectId.trim() : '';
  return projectId.length > 0 ? projectId : null;
}

/**
 * Handles authenticated chat websocket messages used by the main chat panel.
 *
 * Inbound protocol (client to server):
 * - `chat.send`                { sessionId, content, options? }
 * - `chat.abort`               { sessionId }
 * - `chat.subscribe`           { sessions: [{ sessionId, lastSeq? }] }
 * - `chat.permission-response` { requestId, allow, updatedInput?, message?, rememberEntry? }
 * - `files.subscribe`          { projectId }   — watch a project's files
 * - `files.unsubscribe`        { projectId }
 * - `files.watch`              { projectId, path } — stat-poll one file (any allowed root)
 * - `files.unwatch`            { projectId, path }
 *
 * Outbound protocol (server to client): every frame is `kind`-based — either
 * a provider `NormalizedMessage` (with `seq`) or a gateway event
 * (`chat_subscribed`, `session_upserted`, `loading_progress`,
 * `protocol_error`).
 */
export function handleChatConnection(
  ws: WebSocket,
  request: AuthenticatedWebSocketRequest,
  dependencies: ChatWebSocketDependencies
): void {
  console.log('[INFO] Chat WebSocket connected');
  connectedClients.add(ws);

  // Capture the provider runtime gateway so the registry's run-complete handler
  // can drain the server-owned message queue (it has no dependencies of its own).
  ensureQueueDrainingRegistered(dependencies);

  const userId = readRequestUserId(request);

  ws.on('message', async (rawMessage) => {
    try {
      const parsed = parseIncomingJsonObject(rawMessage);
      if (!parsed) {
        throw new Error('Invalid websocket payload');
      }

      const data = parsed as AnyRecord;
      const messageType = typeof data.type === 'string' ? data.type : '';

      switch (messageType) {
        case 'chat.send':
          await handleChatSend(ws, userId, data, dependencies);
          return;
        case 'chat.abort':
          await handleChatAbort(ws, data, dependencies);
          return;
        case 'chat.stop-task':
          await handleChatStopTask(ws, data, dependencies);
          return;
        case 'chat.queue-add':
          await handleChatQueueAdd(ws, userId, data, dependencies);
          return;
        case 'chat.queue-remove':
          await handleChatQueueRemove(ws, data, dependencies);
          return;
        case 'chat.subscribe':
          handleChatSubscribe(ws, data, dependencies);
          return;
        case 'chat.permission-response':
          handlePermissionResponse(data, dependencies);
          return;
        case 'files.subscribe': {
          const projectId = readProjectId(data);
          if (projectId) {
            await subscribeProjectFiles(ws, projectId);
          }
          return;
        }
        case 'files.unsubscribe': {
          const projectId = readProjectId(data);
          if (projectId) {
            unsubscribeProjectFiles(ws, projectId);
          }
          return;
        }
        case 'files.watch': {
          const projectId = readProjectId(data);
          const filePath = typeof data.path === 'string' ? data.path : '';
          if (projectId && filePath) {
            await subscribeFilePath(ws, projectId, filePath);
          }
          return;
        }
        case 'files.unwatch': {
          const projectId = readProjectId(data);
          const filePath = typeof data.path === 'string' ? data.path : '';
          if (projectId && filePath) {
            unsubscribeFilePath(ws, projectId, filePath);
          }
          return;
        }
        default:
          sendProtocolError(ws, 'UNKNOWN_MESSAGE_TYPE', `Unknown message type "${messageType}".`);
          return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ERROR] Chat WebSocket error:', message);
      sendProtocolError(ws, 'INTERNAL_ERROR', message);
    }
  });

  ws.on('close', () => {
    console.log('[INFO] Chat client disconnected');
    connectedClients.delete(ws);
    unsubscribeAllProjectFiles(ws);
    unsubscribeAllFilePaths(ws);
  });
}

/**
 * Boot-time registration of the chat dependencies for server-initiated runs.
 * Same object the websocket layer hands to each connection; registering at
 * listen-time means a server-spawned session (a plugin host module driving a queue) can drain
 * its queue before any browser has ever connected — per-connection
 * registration alone would leave a boot-spawned session enqueued forever on a
 * headless server.
 */
export function registerChatDependenciesAtBoot(dependencies: ChatWebSocketDependencies): void {
  ensureQueueDrainingRegistered(dependencies);
}

/**
 * Server-initiated message send: enqueue + immediate drain, no client socket
 * behind it. Mirrors `handleChatQueueAdd` minus the ws plumbing; the drained
 * run broadcasts to every connected client, so a browser that opens the
 * session later sees the live turn. Returns false when the session row does
 * not exist (caller logs and moves on).
 */
/**
 * Server-initiated abort: the `chat.abort` path without a socket behind it,
 * for a plugin host module enforcing a deadline on a session it drives.
 * Returns false when there is no running turn or the boot dependencies were
 * never registered (a headless server that has not listened yet).
 */
export async function serverAbortRun(sessionId: string): Promise<boolean> {
  const run = chatRunRegistry.getRun(sessionId);
  if (!drainDependencies || !run || run.status !== 'running') {
    return false;
  }
  const success = await drainDependencies.runtime.abort(run.provider, sessionId);
  chatRunRegistry.clearQueue(sessionId, 'aborted');
  chatRunRegistry.completeRun(sessionId, { exitCode: success ? 0 : 1, aborted: true });
  return success;
}

export function serverEnqueueMessage(
  sessionId: string,
  content: string,
  options: AnyRecord = {},
  { userId = null }: { userId?: string | number | null } = {},
): boolean {
  const session = sessionsDb.getSessionById(sessionId);
  if (!session) {
    return false;
  }
  chatRunRegistry.enqueue(sessionId, {
    id: `server_${Date.now()}_${Math.round(Math.random() * 1e9).toString(36)}`,
    content,
    imageCount: 0,
    options,
    userId,
    createdAt: Date.now(),
  });
  if (!chatRunRegistry.isProcessing(sessionId)) {
    void drainQueue(sessionId);
  }
  return true;
}
