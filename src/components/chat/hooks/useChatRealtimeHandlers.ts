import { useEffect, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import type { ServerEvent } from '../../../contexts/WebSocketContext';
import { showCompletionTitleIndicator } from '../../../utils/pageTitleNotification';
import { playChatCompletionSound, playNotificationSound } from '../../../utils/notificationSound';
import type { MarkSessionIdle, MarkSessionProcessing } from '../../../hooks/useSessionProtection';
import type { PendingPermissionRequest } from '../types/types';
import type { ProjectSession, LLMProvider } from '../../../types/app';
import type { SessionStore, NormalizedMessage, ContextUsage } from '../../../stores/useSessionStore';

const isActionablePermissionRequest = (request: { toolName?: unknown } | null | undefined): boolean => {
  return request?.toolName !== 'ExitPlanMode' && request?.toolName !== 'exit_plan_mode';
};

const hasActionablePermissionRequests = (requests: Array<{ toolName?: unknown }> | null | undefined): boolean => {
  return Array.isArray(requests) && requests.some((request) => isActionablePermissionRequest(request));
};

interface UseChatRealtimeHandlersArgs {
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
  provider: LLMProvider;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  setTokenBudget: (budget: Record<string, unknown> | null) => void;
  setContextUsage: (usage: ContextUsage | null) => void;
  pendingPermissionRequests: PendingPermissionRequest[];
  setPendingPermissionRequests: Dispatch<SetStateAction<PendingPermissionRequest[]>>;
  streamTimerRef: MutableRefObject<number | null>;
  /**
   * Text streamed so far, per session id.
   *
   * Keyed rather than a single string because more than one session can stream
   * into this one socket at a time — a background session, or the side session
   * behind a `/btw` question, alongside the one on screen. A shared buffer
   * would splice their deltas together and write the mixture to whichever
   * session's delta happened to land last.
   */
  accumulatedStreamRef: MutableRefObject<Map<string, string>>;
  /**
   * Highest live `seq` observed per session. Essential for reconnect catch-up:
   * `chat.subscribe` sends this value as `lastSeq` so the server replays only
   * the events this client actually missed. Written here on every sequenced
   * frame; read wherever a `chat.subscribe` is sent (session open, reconnect).
   */
  lastSeqRef: MutableRefObject<Map<string, number>>;
  /** When each session's `chat.subscribe` was last sent; guards stale idle acks. */
  statusCheckSentAtRef: MutableRefObject<Map<string, number>>;
  onSessionProcessing?: MarkSessionProcessing;
  onSessionIdle?: MarkSessionIdle;
  onWebSocketReconnect?: () => void;
  sessionStore: SessionStore;
}

/* ------------------------------------------------------------------ */
/*  Hook                                                              */
/* ------------------------------------------------------------------ */

/**
 * Routes server events into the session store and processing-state map.
 *
 * This is intentionally a thin reducer over the unified `kind`-based
 * protocol: every frame is keyed by the stable app session id, so there is
 * no session-id handoff, no provider branching, and no navigation here.
 * Sidebar events (`session_upserted`, `loading_progress`) are handled by
 * `useProjectsState`, not in this hook.
 */
export function useChatRealtimeHandlers({
  subscribe,
  provider,
  selectedSession,
  currentSessionId,
  setTokenBudget,
  setContextUsage,
  pendingPermissionRequests,
  setPendingPermissionRequests,
  streamTimerRef,
  accumulatedStreamRef,
  lastSeqRef,
  statusCheckSentAtRef,
  onSessionProcessing,
  onSessionIdle,
  onWebSocketReconnect,
  sessionStore,
}: UseChatRealtimeHandlersArgs) {
  // Session switches can send `chat.subscribe` before this effect has a chance
  // to rebind the websocket listener. Read the visible session id from a ref
  // so a fast `chat_subscribed` ack is matched against the current view, not
  // the previous render's closed-over selection.
  const activeViewSessionIdRef = useRef<string | null>(selectedSession?.id || currentSessionId || null);
  activeViewSessionIdRef.current = selectedSession?.id || currentSessionId || null;

  // Keep the latest pending-permission snapshot available to the websocket
  // listener so back-to-back permission events can dedupe and re-arm the
  // notification sound before React finishes a rerender.
  const pendingPermissionRequestsRef = useRef(pendingPermissionRequests);

  useEffect(() => {
    pendingPermissionRequestsRef.current = pendingPermissionRequests;
  }, [pendingPermissionRequests]);

  useEffect(() => {
    const handleEvent = (msg: ServerEvent) => {
      if (!msg.kind) {
        return;
      }

      const activeViewSessionId = activeViewSessionIdRef.current;
      const sid = (typeof msg.sessionId === 'string' && msg.sessionId) || activeViewSessionId;

      // Record replay progress for every sequenced live event.
      if (sid && typeof msg.seq === 'number') {
        const known = lastSeqRef.current.get(sid) ?? 0;
        if (msg.seq > known) {
          lastSeqRef.current.set(sid, msg.seq);
        }
      }

      switch (msg.kind) {
        case 'websocket_reconnected':
          onWebSocketReconnect?.();
          // The composer replays a send still waiting for its ack: the socket
          // that carried it may have died before the server read the frame,
          // and nothing else would ever retry it.
          window.dispatchEvent(new CustomEvent('vibespace:websocket-reconnected'));
          return;

        case 'send_ack': {
          // Id-correlated receipt for a dispatched chat.send — the ONLY thing
          // that acks a 'send' entry out of the composer's pending-send
          // journal. (An earlier heuristic acked on any sequenced live event
          // for the session; replayed events from a previous run then falsely
          // acked sends that died on a dead socket, deleting the sole copy.)
          if (sid && typeof msg.clientMsgId === 'string') {
            window.dispatchEvent(
              new CustomEvent('vibespace:send-acked', {
                detail: { sessionId: sid, clientMsgId: msg.clientMsgId },
              }),
            );
          }
          return;
        }

        case 'chat_subscribed': {
          // Ack for chat.subscribe: authoritative processing state plus any
          // pending tool-permission prompts for the run.
          if (!sid) return;

          if (msg.isProcessing) {
            onSessionProcessing?.(sid);
          } else {
            // Idle ack: ignore it if a newer request started after the
            // subscribe was sent — the ack describes the older state.
            onSessionIdle?.(sid, {
              ifStartedBefore: statusCheckSentAtRef.current.get(sid),
            });
          }

          // Server-owned message queue snapshot for this session — hand it to
          // the composer so a freshly-opened client shows what another browser
          // queued.
          if (Array.isArray(msg.queue)) {
            window.dispatchEvent(
              new CustomEvent('vibespace:queue-updated', {
                detail: { sessionId: sid, queue: msg.queue },
              }),
            );
          }

          const isViewedSession = sid === activeViewSessionId;
          if (isViewedSession && Array.isArray(msg.pendingPermissions)) {
            const nextPendingPermissionRequests = msg.pendingPermissions as PendingPermissionRequest[];
            const hadActionablePermissionRequests = hasActionablePermissionRequests(pendingPermissionRequestsRef.current);
            const hasPendingActionablePermissionRequests = hasActionablePermissionRequests(nextPendingPermissionRequests);

            pendingPermissionRequestsRef.current = nextPendingPermissionRequests;
            setPendingPermissionRequests(nextPendingPermissionRequests);

            if (hasPendingActionablePermissionRequests && !hadActionablePermissionRequests) {
              void playNotificationSound();
            }
          }
          return;
        }

        case 'protocol_error': {
          console.error('[Chat] Protocol error:', msg.code, msg.error);
          if (sid) {
            if (msg.code === 'RUN_IN_PROGRESS') {
              // Not a real failure — a run IS active for this session, the
              // client just thought it was idle (state-desync). Reflect the
              // truth (processing, interruptible) rather than dropping the
              // spinner, and hand the just-rejected send back to the composer
              // so it re-queues instead of vanishing. No error bubble.
              onSessionProcessing?.(sid, { canInterrupt: true });
              window.dispatchEvent(
                new CustomEvent('vibespace:run-in-progress', { detail: { sessionId: sid } }),
              );
              return;
            }
            // Surface the failure in the conversation and stop the spinner —
            // the run never started (or was rejected), so no `complete` follows.
            onSessionIdle?.(sid);
            sessionStore.appendRealtime(sid, {
              id: `protocol_error_${Date.now()}`,
              sessionId: sid,
              timestamp: new Date().toISOString(),
              provider,
              kind: 'error',
              content: String(msg.error || 'Request failed'),
            } as NormalizedMessage);
          }
          return;
        }

        case 'queue_updated': {
          // Server broadcast: the shared message queue for a session changed.
          // Route to the composer, which renders/reconciles only its session.
          if (sid) {
            window.dispatchEvent(
              new CustomEvent('vibespace:queue-updated', {
                detail: {
                  sessionId: sid,
                  queue: Array.isArray(msg.queue) ? msg.queue : [],
                  // Items dropped without being sent (the user removed one, or
                  // Stop cancelled it) — the composer takes their text back.
                  removed: Array.isArray(msg.removed) ? msg.removed : [],
                },
              }),
            );
          }
          return;
        }

        // Sidebar/global events — owned by useProjectsState.
        case 'session_upserted':
        case 'loading_progress':
          return;

        default:
          break;
      }

      /* -------------------------------------------------------------- */
      /*  Provider NormalizedMessage handling                            */
      /* -------------------------------------------------------------- */

      // --- Streaming: buffer for performance ---
      if (msg.kind === 'stream_delta') {
        const text = (msg.content as string) || '';
        if (!text || !sid) return;
        const buffers = accumulatedStreamRef.current;
        buffers.set(sid, (buffers.get(sid) ?? '') + text);
        // One shared timer, but it flushes every session that has buffered
        // text — each to its own store entry — so concurrent streams stay
        // separate while still costing a single 100ms repaint.
        if (!streamTimerRef.current) {
          streamTimerRef.current = window.setTimeout(() => {
            streamTimerRef.current = null;
            buffers.forEach((buffered, bufferedSessionId) => {
              sessionStore.updateStreaming(bufferedSessionId, buffered, provider);
            });
          }, 100);
        }
        // Also route to store for non-active sessions
        if (sid !== activeViewSessionId) {
          sessionStore.appendRealtime(sid, msg as unknown as NormalizedMessage);
        }
        return;
      }

      if (msg.kind === 'stream_end') {
        if (sid) {
          const buffered = accumulatedStreamRef.current.get(sid);
          if (buffered) {
            sessionStore.updateStreaming(sid, buffered, provider);
          }
          sessionStore.finalizeStreaming(sid);
          accumulatedStreamRef.current.delete(sid);
        }
        return;
      }

      // --- All other messages: route to store ---
      const shouldPersist =
        msg.kind !== 'complete'
        && msg.kind !== 'status'
        && msg.kind !== 'permission_request'
        && msg.kind !== 'permission_cancelled';

      if (sid && shouldPersist) {
        sessionStore.appendRealtime(sid, msg as unknown as NormalizedMessage);
      }

      // --- UI side effects for specific kinds ---
      switch (msg.kind) {
        case 'complete': {
          // Flush whatever this session had buffered. Other sessions keep
          // theirs: one run finishing says nothing about the rest.
          if (sid) {
            const buffered = accumulatedStreamRef.current.get(sid);
            if (buffered) {
              sessionStore.updateStreaming(sid, buffered, provider);
              sessionStore.finalizeStreaming(sid);
            }
            accumulatedStreamRef.current.delete(sid);
          }

          // `complete` is the unified terminal event — every provider run ends
          // with exactly one, regardless of success, failure, or abort. The
          // indicator derives from the processing map, so deleting the entry
          // hides it immediately and atomically.
          onSessionIdle?.(sid);
          if (sid === activeViewSessionId) {
            pendingPermissionRequestsRef.current = [];
            setPendingPermissionRequests([]);
          }

          if (msg.aborted) {
            // Abort was requested — the complete event confirms it. No
            // further UI action is needed beyond clearing the entry above.
            break;
          }

          // Celebrate only successful runs (failed runs end with success: false).
          if (msg.success !== false) {
            showCompletionTitleIndicator();
            void playChatCompletionSound();
          }

          // The session id is stable for the whole conversation (allocated
          // before the first send), so the only follow-up is syncing the
          // viewed conversation with the now-persisted transcript.
          if (sid && sid === activeViewSessionId) {
            void sessionStore.refreshFromServer(sid);
          }

          break;
        }

        // 'error' is an informational message row, not a terminal event —
        // providers emit it for mid-run stderr output too. Run teardown is
        // always signalled by the unified 'complete' that follows.

        case 'permission_request': {
          if (!msg.requestId) break;
          if (isActionablePermissionRequest({ toolName: msg.toolName })) {
            void playNotificationSound();
          }

          if (sid === activeViewSessionId) {
            const previousPendingPermissionRequests = pendingPermissionRequestsRef.current;
            if (!previousPendingPermissionRequests.some((request) => request.requestId === msg.requestId)) {
              const nextPendingPermissionRequests = [...previousPendingPermissionRequests, {
                requestId: msg.requestId as string,
                toolName: (msg.toolName as string) || 'UnknownTool',
                input: msg.input,
                context: msg.context,
                sessionId: sid || null,
                receivedAt: new Date(),
              }];

              pendingPermissionRequestsRef.current = nextPendingPermissionRequests;
              setPendingPermissionRequests(nextPendingPermissionRequests);
            }
          }
          if (sid) {
            onSessionProcessing?.(sid);
          }
          break;
        }

        case 'permission_cancelled': {
          if (msg.requestId && sid === activeViewSessionId) {
            const nextPendingPermissionRequests = pendingPermissionRequestsRef.current.filter(
              (request: PendingPermissionRequest) => request.requestId !== msg.requestId,
            );

            pendingPermissionRequestsRef.current = nextPendingPermissionRequests;
            setPendingPermissionRequests(nextPendingPermissionRequests);
          }
          break;
        }

        case 'status': {
          // Both readings below are single-value state for the session on
          // screen, so they must be gated on the message belonging to it.
          // Ungated, any background session's probe painted its number onto
          // whatever session you were looking at — which is how a brand-new
          // session came to display the 500k reading of a long run happening
          // in another tab. `sid` falls back to the active view when the
          // message carries no sessionId, so this does not drop our own.
          const isViewedSession = sid === activeViewSessionId;

          if (msg.text === 'token_budget') {
            if (msg.tokenBudget && isViewedSession) {
              setTokenBudget(msg.tokenBudget as Record<string, unknown>);
            }
          } else if (msg.text === 'context_usage') {
            // Data-only status: the runtime's authoritative context reading.
            // Must not fall through to the processing branch below — it can
            // arrive just after a run's terminal `complete` (the probe is a
            // round-trip to the CLI), which would revive the spinner.
            if (msg.contextUsage && isViewedSession) {
              setContextUsage(msg.contextUsage as ContextUsage);
            }
          } else if (sid) {
            // A null/absent text is a deliberate clear — the agent stopped
            // running tools and is writing, so the indicator goes back to its
            // own rotating words rather than freezing on the last tool.
            onSessionProcessing?.(sid, {
              statusText: typeof msg.text === 'string' && msg.text ? msg.text : null,
              canInterrupt: msg.canInterrupt !== false,
            });
          }
          break;
        }

        // text, tool_use, tool_result, thinking, interactive_prompt, task_notification
        // → already routed to store above, no UI side effects needed
        default:
          break;
      }
    };

    return subscribe(handleEvent);
  }, [
    subscribe,
    provider,
    selectedSession,
    currentSessionId,
    setTokenBudget,
    setContextUsage,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    streamTimerRef,
    accumulatedStreamRef,
    lastSeqRef,
    statusCheckSentAtRef,
    onSessionProcessing,
    onSessionIdle,
    onWebSocketReconnect,
    sessionStore,
  ]);
}
