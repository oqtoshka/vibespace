import path from 'node:path';

import type { WebSocket } from 'ws';

import { peerOutboxDb, sessionsDb } from '@/modules/database/index.js';
import { providerModelsService, sessionsService } from '@/modules/providers/index.js';
import { chatRunRegistry, MAX_QUEUED_MESSAGES } from '@/modules/websocket/services/chat-run-registry.service.js';
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
  CheckedEnqueueResult,
  PeerAdmissionInput,
  PeerAdmissionResult,
  PeerOutboxRecord,
  LLMProvider,
  ProviderPermissionDecision,
  ProviderRuntimeWriter,
} from '@/shared/types.js';
import { createNormalizedMessage, parseIncomingJsonObject } from '@/shared/utils.js';
import { parseStoredLaunchOptions } from '@/shared/agent-env.js';

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
    // Launch options are likewise the row's: the plugins that declared them
    // add env, instructions and tool servers to the harness process (see
    // collectAgentLaunchExtras); the client cannot ask for them per turn.
    launchOptions: parseStoredLaunchOptions(session.launch_options),
    // OpenCode can only accept `delivery: "steer"` while the conversation is
    // running through its server engine. Interactive websocket turns opt into
    // that transport; internal one-shot helpers keep using the lighter CLI.
    enableMidTurnInjection: provider === 'opencode',
  };

  // Claude background-job auto-resume: when a `run_in_background` job finishes
  // after its turn, the persistent session opens its OWN run for the resumed
  // turn (server-initiated, no client send) so its output is sequenced/replayed
  // and the session shows as processing again.
  if (provider === 'claude') {
    runtimeOptions.acquireResumeRun = () => chatRunRegistry.startResumeRun(appSessionId);
    // A resume or nudge refused by a turn-admission reservation waits for it
    // to end instead of being dropped (or, worse, running without a run while
    // a host mutation holds the session).
    runtimeOptions.isTurnAdmissionReserved = () => chatRunRegistry.isAdmissionReserved(appSessionId);
    runtimeOptions.whenTurnAdmissionFree = () => chatRunRegistry.whenAdmissionFree(appSessionId);
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
  if (typeof clientOptions.permissionMode === 'string' && clientOptions.permissionMode.trim()) {
    sessionsDb.setSessionPermissionMode(sessionId, clientOptions.permissionMode !== 'plan' && clientOptions.toolsSettings?.skipPermissions ? 'bypassPermissions' : clientOptions.permissionMode);
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

  await executeStartedRun(appSessionId, run, item, session, provider, dependencies);
}

/**
 * Runs one already-started queued turn to completion. Shared by `drainQueue`
 * and the peer outbox dispatcher so both hand a message to the runtime the
 * same way.
 */
async function executeStartedRun(
  appSessionId: string,
  run: NonNullable<ReturnType<typeof chatRunRegistry.startQueuedRun>>,
  item: { content: string; options?: AnyRecord; userId?: string | number | null },
  session: NonNullable<ReturnType<typeof sessionsDb.getSessionById>>,
  provider: LLMProvider,
  dependencies: ChatWebSocketDependencies,
): Promise<void> {
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
    // the next queued item (if any). Run-scoped: if the runtime already
    // emitted its own complete and the drain started the next turn, this
    // late settle must not end that newer run.
    chatRunRegistry.completeRunIfCurrent(run, { exitCode: 1 });
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
  const drainAfterAdmission = (appSessionId: string) => {
    // drainQueue starts its run synchronously, so the outbox dispatch below
    // sees the session busy and waits for the next completion: the ordinary
    // queue always goes first.
    void drainQueue(appSessionId);
    tryDispatchPeerOutbox(appSessionId);
  };
  chatRunRegistry.setRunCompleteHandler(drainAfterAdmission);
  // A turn-admission reservation refuses the drain and the outbox like a
  // running turn does, but ends without a `complete`: its end re-drains.
  chatRunRegistry.setAdmissionReleasedHandler(drainAfterAdmission);
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

  const command = typeof data.content === 'string' ? data.content : '';
  sessionsService.seedDerivedSessionNameFromMessage(sessionId, command);

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
    if (!chatRunRegistry.isProcessing(sessionId) && chatRunRegistry.isAdmissionReserved(sessionId)) {
      // No run is active: a host integration holds the session's turn
      // admission for a few seconds (resource cleanup). The client re-queues
      // the message and the reservation's end drains it.
      sendProtocolError(
        ws,
        'RUN_ADMISSION_RESERVED',
        `Session "${sessionId}" is paused for a moment while a resource cleanup finishes; the message will be sent after it.`,
        sessionId
      );
      return;
    }
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

  // Stop cancels accepted peer messages even when no turn is running — a
  // pending row on an idle recipient (runtime loss, restart) would otherwise
  // dispatch later as a surprise — and holds peer dispatch off until the abort
  // below has finished.
  beginPeerStop(sessionId);
  try {
    const run = chatRunRegistry.getRun(sessionId);
    if (!run || run.status !== 'running') {
      sendProtocolError(ws, 'NO_ACTIVE_RUN', `Session "${sessionId}" has no active run.`, sessionId);
      return;
    }
    await abortRunAndStopQueues(run, sessionId, dependencies);
  } finally {
    endPeerStop(sessionId);
  }
}

/**
 * The shared tail of both Stop paths. Clears the ordinary queue and cancels
 * peer rows admitted while the abort was in flight, then completes the
 * aborted run. Returns the runtime's abort result.
 */
async function abortRunAndStopQueues(
  run: NonNullable<ReturnType<typeof chatRunRegistry.getRun>>,
  sessionId: string,
  dependencies: ChatWebSocketDependencies,
): Promise<boolean> {
  const success = await dependencies.runtime.abort(run.provider, sessionId);

  // Stop stops everything the user has lined up, not just the current turn:
  // without this the terminal `complete` below would immediately drain the
  // queue and start a new run from the message they queued during the one they
  // just stopped. Each dropped message's text goes back to the composer.
  // (Messages the runtime already holds are cancelled inside the abort above,
  // which removes them the same way.)
  chatRunRegistry.clearQueue(sessionId, 'aborted');
  // Peer rows admitted while the abort was in flight are cancelled too —
  // recorded as `cancelled: recipient-aborted`, so a replay reports it.
  peerOutboxDb.cancelPendingForRecipient(sessionId, 'recipient-aborted');

  chatRunRegistry.completeRun(sessionId, {
    exitCode: success ? 0 : 1,
    aborted: true,
  });
  return success;
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
  // The peer outbox sweeper is NOT started here: this runs at module load in
  // server/index.js, before initializeDatabase() has created `peer_outbox`, and
  // a sweep against the missing table threw at boot. startServer() starts it
  // once the schema exists.
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
  // Same peer policy as chat.abort: cancel even with nothing running (still
  // returning false), and hold dispatch off until the abort has finished.
  beginPeerStop(sessionId);
  try {
    const run = chatRunRegistry.getRun(sessionId);
    if (!drainDependencies || !run || run.status !== 'running') {
      return false;
    }
    return await abortRunAndStopQueues(run, sessionId, drainDependencies);
  } finally {
    endPeerStop(sessionId);
  }
}

/**
 * `serverEnqueueMessage` for callers that must not claim acceptance of a
 * message the drain would drop. Consumer: the plugin host's
 * `enqueueMessageChecked` (cross-session peer messages).
 *
 * `drainQueue` dequeues before it checks the provider runtime, so an item
 * queued while the runtime is unavailable is silently lost, and `enqueue`
 * silently evicts the oldest item at the cap. This refuses both cases before
 * anything is queued, so a refused caller can retry later with nothing to
 * duplicate. It does not make the queue durable: an accepted item still lives
 * only in memory and is lost on a server restart.
 */
export function serverEnqueueMessageChecked(
  sessionId: string,
  content: string,
  options: AnyRecord = {},
): CheckedEnqueueResult {
  const session = sessionsDb.getSessionById(sessionId);
  if (!session) {
    return { outcome: 'missing' };
  }
  const provider = session.provider as LLMProvider | undefined;
  const dependencies = drainDependencies;
  if (!dependencies || !provider || !dependencies.runtime.hasRuntime(provider)) {
    return { outcome: 'runtime-unavailable' };
  }
  if (chatRunRegistry.getQueueForClient(sessionId).length >= MAX_QUEUED_MESSAGES) {
    return { outcome: 'queue-full' };
  }
  const recipientBusy = chatRunRegistry.isProcessing(sessionId);
  serverEnqueueMessage(sessionId, content, options);
  return { outcome: 'accepted', recipientBusy };
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

/**
 * Plugin-host background follow-ups (the Janitor's owner check) use this instead
 * of joining an operator's queue. It observes, synchronously with the enqueue, a
 * completed last run bound to the expected native session, an empty queue, no
 * turn-admission reservation and no pending permission. False means no admission
 * — including unavailable evidence — never proof the session is dead.
 * Business-specific completion/consent checks remain the plugin's responsibility.
 */
export function serverEnqueueMessageIfIdle(
  sessionId: string,
  expectedProviderSessionId: string,
  content: string,
  options: AnyRecord = {},
): boolean {
  try {
    const dependencies = drainDependencies;
    if (!dependencies || !expectedProviderSessionId || !content.trim()) return false;
    const session = sessionsDb.getSessionById(sessionId);
    const run = chatRunRegistry.getRun(sessionId);
    if (!session || session.isArchived || session.is_private !== 0
      || session.provider_session_id !== expectedProviderSessionId
      || !run || run.status !== 'completed' || run.providerSessionId !== expectedProviderSessionId
      || !dependencies.runtime.hasRuntime(session.provider as LLMProvider)
      || chatRunRegistry.hasQueued(sessionId)
      || chatRunRegistry.getQueueForClient(sessionId).length !== 0
      || chatRunRegistry.isAdmissionReserved(sessionId)
      || dependencies.runtime.getPendingApprovalsForSession(sessionId).length !== 0) return false;
    // No await between the checks and server-owned queue admission: the drain
    // takes the running turn synchronously, so a second follow-up cannot slip in.
    return serverEnqueueMessage(sessionId, content, options);
  } catch {
    return false;
  }
}

/*
 * Durable peer outbox.
 *
 * Accepted cross-session peer messages live in the `peer_outbox` table, not in
 * the in-memory chat queue, so neither a server restart nor a runtime that is
 * missing at drain time can lose one silently. The ordinary chat queue and its
 * callers are untouched.
 *
 * - Admission is idempotent on (sender, requestId). A replay returns the row as
 *   it is now; it never creates a second row or a second dispatch.
 * - A row is handed to the runtime only while the recipient is idle, its
 *   ordinary queue is empty, and its provider has a runtime. Nothing is removed
 *   before that check: an ineligible runtime just leaves the row `pending`.
 * - Before every dispatch the recipient is re-validated against the row: it
 *   must still exist, be public, be unarchived and be in the same project.
 *   Otherwise the row is `cancelled` with the reason. Nothing here creates a
 *   session or wakes an archived or private one.
 * - The row is marked `dispatched` *before* the runtime is called. A crash
 *   between the two leaves `dispatched` with an unknown fate, and it is never
 *   replayed automatically: at-most-once, not exactly-once.
 * - Operator Stop cancels the recipient's pending rows (`recipient-aborted`).
 * - Retries are bounded: every run completion, every admission and one
 *   host-owned sweeper try again; a row still pending after
 *   PEER_OUTBOX_MAX_PENDING_MS is cancelled as `expired`.
 */

/** Per-recipient cap on pending rows — the chat queue's cap of 20 (a literal:
 * the registry constant is not yet initialised when a circular import loads
 * this module first). */
export const PEER_OUTBOX_MAX_PENDING = 20;
/** A pending row older than this is cancelled as `expired`, never sent late. */
export const PEER_OUTBOX_MAX_PENDING_MS = 24 * 60 * 60 * 1000;
const PEER_OUTBOX_SWEEP_MS = 30 * 1000;

function toPeerRecord(entry: PeerOutboxRecord & { content?: string; projectPath?: string }): PeerOutboxRecord {
  const { content: _content, projectPath: _projectPath, ...record } = entry;
  return record;
}

function isPublic(row: { is_private?: unknown }): boolean {
  return row.is_private === 0 || row.is_private === false;
}

function isArchived(row: { isArchived?: unknown }): boolean {
  return row.isArchived === 1 || row.isArchived === true;
}

function projectOf(row: { project_path?: unknown }): string | null {
  const value = typeof row.project_path === 'string' ? row.project_path.trim() : '';
  return value === '' ? null : value;
}

/** Why a sender may no longer speak for `projectPath`, or null if it still may. */
function senderIneligibility(senderSessionId: string, projectPath: string): string | null {
  const row = sessionsDb.getSessionById(senderSessionId);
  if (!row) return 'sender-missing';
  if (isArchived(row)) return 'sender-archived';
  if (!isPublic(row)) return 'sender-private';
  if (projectOf(row) !== projectPath) return 'sender-left-project';
  return null;
}

/**
 * A pending row expires when its age is at least PEER_OUTBOX_MAX_PENDING_MS
 * (age >= bound). The sweeper and every dispatch use this same definition.
 */
function isPeerRowExpired(acceptedAt: string, nowMs: number = Date.now()): boolean {
  const acceptedMs = Date.parse(acceptedAt);
  return !Number.isFinite(acceptedMs) || nowMs - acceptedMs >= PEER_OUTBOX_MAX_PENDING_MS;
}

/** Recipients with a Stop in flight; the dispatcher launches nothing for them. */
const peerStopsInFlight = new Map<string, number>();

/** Called at the start of both Stop paths: cancels the recipient's pending
 * peer rows and suppresses dispatch until `endPeerStop`. Counted, so
 * overlapping Stops for one session nest correctly. */
function beginPeerStop(sessionId: string): void {
  peerStopsInFlight.set(sessionId, (peerStopsInFlight.get(sessionId) ?? 0) + 1);
  peerOutboxDb.cancelPendingForRecipient(sessionId, 'recipient-aborted');
}

function endPeerStop(sessionId: string): void {
  const remaining = (peerStopsInFlight.get(sessionId) ?? 1) - 1;
  if (remaining > 0) peerStopsInFlight.set(sessionId, remaining);
  else peerStopsInFlight.delete(sessionId);
}

/** Why a recipient may not receive a row for `projectPath`, or null if it may. */
function recipientIneligibility(recipientSessionId: string, projectPath: string): string | null {
  const row = sessionsDb.getSessionById(recipientSessionId);
  if (!row) return 'recipient-missing';
  if (isArchived(row)) return 'recipient-archived';
  if (!isPublic(row)) return 'recipient-private';
  if (projectOf(row) !== projectPath) return 'recipient-left-project';
  return null;
}

/**
 * Plugin host `peerOutbox.get`. Consumer: server/index.js host wiring.
 */
export function getPeerMessage(senderSessionId: string, requestId: string): PeerOutboxRecord | null {
  const entry = peerOutboxDb.get(senderSessionId, requestId);
  return entry ? toPeerRecord(entry) : null;
}

/**
 * Plugin host `peerOutbox.admit`. Consumer: server/index.js host wiring.
 * Refusals persist nothing, so the same requestId may be retried.
 */
export function admitPeerMessage(input: PeerAdmissionInput): PeerAdmissionResult {
  const existing = peerOutboxDb.get(input.senderSessionId, input.requestId);
  if (existing) {
    return existing.fingerprint === input.fingerprint
      ? { outcome: 'existing', record: toPeerRecord(existing) }
      : { outcome: 'conflict' };
  }
  const sender = sessionsDb.getSessionById(input.senderSessionId);
  if (!sender) return { outcome: 'missing', reason: 'sender-missing' };
  if (isArchived(sender) || !isPublic(sender)) return { outcome: 'ineligible', reason: 'sender-ineligible' };
  const projectPath = projectOf(sender);
  if (!projectPath) return { outcome: 'ineligible', reason: 'sender-has-no-project' };
  if (input.recipientSessionId === input.senderSessionId) return { outcome: 'ineligible', reason: 'recipient-is-sender' };
  const ineligible = recipientIneligibility(input.recipientSessionId, projectPath);
  if (ineligible === 'recipient-missing') return { outcome: 'missing', reason: ineligible };
  if (ineligible) return { outcome: 'ineligible', reason: ineligible };
  const recipient = sessionsDb.getSessionById(input.recipientSessionId);
  const provider = recipient?.provider as LLMProvider | undefined;
  if (!drainDependencies || !provider || !drainDependencies.runtime.hasRuntime(provider)) {
    return { outcome: 'runtime-unavailable' };
  }
  if (peerOutboxDb.countPending(input.recipientSessionId) >= PEER_OUTBOX_MAX_PENDING) {
    return { outcome: 'queue-full' };
  }
  if (!peerOutboxDb.insertPending({ ...input, projectPath })) {
    // Lost a race with an identical key: report what is stored.
    const raced = peerOutboxDb.get(input.senderSessionId, input.requestId);
    if (!raced) return { outcome: 'conflict' };
    return raced.fingerprint === input.fingerprint
      ? { outcome: 'existing', record: toPeerRecord(raced) }
      : { outcome: 'conflict' };
  }
  dispatchPeerOutbox(input.recipientSessionId);
  const stored = peerOutboxDb.get(input.senderSessionId, input.requestId);
  return { outcome: 'accepted', record: toPeerRecord(stored!) };
}

/**
 * Hands the recipient's oldest eligible pending row to its runtime, if it can
 * right now. Synchronous up to the dispatch mark; the run itself continues in
 * the background and its completion re-enters here for the next row.
 * Exported for tests and the sweeper.
 */
export function dispatchPeerOutbox(recipientSessionId: string): void {
  const dependencies = drainDependencies;
  if (!dependencies) return;
  // A Stop is in flight for this recipient: nothing may launch until it ends.
  if (peerStopsInFlight.has(recipientSessionId)) return;
  for (;;) {
    if (chatRunRegistry.isProcessing(recipientSessionId) || chatRunRegistry.hasQueued(recipientSessionId)) return;
    const entry = peerOutboxDb.nextPending(recipientSessionId);
    if (!entry) return;
    // The age bound is enforced here, on every dispatch path, not only by the
    // sweeper: an expired row is cancelled, never sent late.
    if (isPeerRowExpired(entry.acceptedAt)) {
      peerOutboxDb.cancel(entry.senderSessionId, entry.requestId, 'expired');
      continue;
    }
    // The sender is re-validated too (fail closed): a sender that has since
    // become private, been archived, left the project or been deleted no
    // longer speaks for this project. Dispatched rows are never rewritten.
    const ineligible = senderIneligibility(entry.senderSessionId, entry.projectPath)
      ?? recipientIneligibility(recipientSessionId, entry.projectPath);
    if (ineligible) {
      peerOutboxDb.cancel(entry.senderSessionId, entry.requestId, ineligible);
      continue;
    }
    const session = sessionsDb.getSessionById(recipientSessionId)!;
    const provider = session.provider as LLMProvider | undefined;
    // Runtime not available: leave the row pending. Nothing was dequeued.
    if (!provider || !dependencies.runtime.hasRuntime(provider)) return;
    const run = chatRunRegistry.startQueuedRun(recipientSessionId);
    if (!run) return;
    if (!peerOutboxDb.markDispatched(entry.senderSessionId, entry.requestId)) {
      chatRunRegistry.completeRunIfCurrent(run, { exitCode: 1 });
      return;
    }
    void executeStartedRun(recipientSessionId, run, { content: entry.content, userId: null }, session, provider, dependencies);
    return;
  }
}

/**
 * One bounded retry pass over every recipient with pending rows: expires rows
 * older than PEER_OUTBOX_MAX_PENDING_MS, then tries each recipient once.
 * Exported for tests.
 */
export function sweepPeerOutbox(nowMs: number = Date.now()): void {
  peerOutboxDb.cancelPendingAcceptedAtOrBefore(new Date(nowMs - PEER_OUTBOX_MAX_PENDING_MS).toISOString(), 'expired');
  for (const recipient of peerOutboxDb.recipientsWithPending()) {
    dispatchPeerOutbox(recipient);
  }
}

/** A dispatch failure (e.g. the database is closing) is logged, never thrown
 * into the run-complete handler: rows stay pending for the next attempt. */
function tryDispatchPeerOutbox(recipientSessionId: string): void {
  try {
    dispatchPeerOutbox(recipientSessionId);
  } catch (error) {
    console.error('[Chat] Peer outbox dispatch failed', { sessionId: recipientSessionId, error: error instanceof Error ? error.message : String(error) });
  }
}

let peerOutboxSweeper: ReturnType<typeof setInterval> | null = null;

/**
 * Starts the single host-owned sweeper (idempotent, unref'd so it never holds
 * the process open) and runs one pass immediately — which is what re-attempts
 * rows left pending by a restart. Returns a stop function. Consumer:
 * server/index.js startServer(), after initializeDatabase().
 */
export function startPeerOutboxSweeper(intervalMs: number = PEER_OUTBOX_SWEEP_MS): () => void {
  if (!peerOutboxSweeper) {
    peerOutboxSweeper = setInterval(() => {
      try { sweepPeerOutbox(); } catch (error) {
        console.error('[Chat] Peer outbox sweep failed', { error: error instanceof Error ? error.message : String(error) });
      }
    }, intervalMs);
    peerOutboxSweeper.unref?.();
  }
  // Same guard as the interval: a failed pass leaves rows pending for the next
  // tick, it never throws into the caller (boot).
  try { sweepPeerOutbox(); } catch (error) {
    console.error('[Chat] Peer outbox sweep failed', { error: error instanceof Error ? error.message : String(error) });
  }
  return stopPeerOutboxSweeper;
}

export function stopPeerOutboxSweeper(): void {
  if (peerOutboxSweeper) clearInterval(peerOutboxSweeper);
  peerOutboxSweeper = null;
}
