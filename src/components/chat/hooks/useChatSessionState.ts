import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import type { MarkSessionIdle, SessionActivityMap } from '../../../hooks/useSessionProtection';
import type { Project, ProjectSession, LLMProvider } from '../../../types/app';
import type { SessionStore, NormalizedMessage, ContextUsage } from '../../../stores/useSessionStore';
import type { ChatMessage } from '../types/types';
import { getIntrinsicMessageKey } from '../utils/messageKeys';
import { createCachedDiffCalculator, type DiffCalculator } from '../utils/messageTransforms';

import { normalizedToChatMessages } from './useChatMessages';

const MESSAGES_PER_PAGE = 20;
const INITIAL_VISIBLE_MESSAGES = 100;

/**
 * How close to the bottom counts as "following the transcript", so new output
 * keeps scrolling into view. Deliberately tight: this is the distance at which
 * auto-scroll takes the view back, and anything looser fights the reader —
 * nudging up 30px to re-read the last line used to still count as at-bottom,
 * so the next message yanked the view down again, once per message.
 */
const FOLLOW_BOTTOM_PX = 4;

/**
 * How far up the reader has to be before the floating "scroll to bottom"
 * button appears. Separate from following: a small nudge stops auto-scroll
 * immediately, but shouldn't pop a button over the transcript.
 */
const SCROLL_TO_BOTTOM_BUTTON_PX = 120;

interface UseChatSessionStateArgs {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  externalMessageUpdate?: number;
  newSessionTrigger?: number;
  processingSessions?: SessionActivityMap;
  onSessionIdle?: MarkSessionIdle;
  resetStreamingState: () => void;
  /** When each session's `chat.subscribe` was last sent; guards stale idle acks. */
  statusCheckSentAtRef: MutableRefObject<Map<string, number>>;
  /** Highest live seq observed per session; sent as `lastSeq` on subscribe. */
  lastSeqRef: MutableRefObject<Map<string, number>>;
  sessionStore: SessionStore;
}

/**
 * Where the reader is in the transcript, expressed as a message element and how
 * far below the top edge of the viewport it sits.
 *
 * Not a scroll offset: a scroll offset only means anything until the content
 * above it changes size, and in a transcript it changes constantly — an older
 * page is prepended, a code block finishes highlighting, an image decodes. An
 * element and its distance from the top edge survive all of that, so the
 * correction is always "put this message back where the reader had it",
 * measured against the layout that exists at the moment of the correction.
 */
interface ScrollAnchor {
  element: Element;
  offset: number;
}

/**
 * How far into a message to look for the anchor. Deep enough to get past the
 * wrappers a message is built from, shallow enough that the element survives
 * the re-render a prepended page causes and can still be measured afterwards.
 */
const SCROLL_ANCHOR_MAX_DEPTH = 3;

/**
 * Picks what to hold still: the first element that starts at or below the top
 * edge of the viewport.
 *
 * The obvious choice — the topmost element still on screen — is wrong, and
 * wrong in exactly the case the reader meets while scrolling up through the
 * transcript for the first time. That element is *clipped* by the top edge, so
 * when its own contents settle a moment later (a code block highlights, an
 * image decodes) it grows downwards while its top stays exactly where it was.
 * The measured drift is zero, no correction is made, and everything the reader
 * is looking at slides down the screen. Measured in a real engine with
 * `overflow-anchor: none`: the anchor reported 0 px of drift while the reader
 * was pushed 200 px. Scrolling back through the same messages afterwards is
 * smooth, because by then they have finished settling — which is why this only
 * ever bit on the way up through new ground.
 *
 * An element that starts below the edge has nothing clipped above it, so any
 * height change above it — inside its own ancestors included — moves it, and a
 * correction that puts it back puts the whole viewport back with it.
 *
 * Elements marked `data-transcript-anchor="skip"` are passed over. The
 * transcript's own furniture lives among the messages — the "showing 50 of 900"
 * banner, the load-all pill — and anchoring to any of it breaks the correction
 * outright. The pill is the worst of them: it is `sticky`, so once stuck its
 * rect stays pinned to the top edge no matter how far the content beneath it
 * moves. Anchored to that, every measurement reports zero drift while the
 * reader is being pushed down the page, which is silent and total failure. It
 * is also mounted on a timer and unmounted 2.5 s later, and it sits above the
 * first message, so while it exists it wins this search every time.
 */
function pickScrollAnchorElement(scope: Element, containerTop: number, depth: number): Element | null {
  for (const element of Array.from(scope.children)) {
    if (element.getAttribute('data-transcript-anchor') === 'skip') continue;
    const rect = element.getBoundingClientRect();
    if (rect.bottom <= containerTop) continue;

    if (rect.top >= containerTop) return element;

    // Clipped by the edge. Its own children may still start below it.
    if (depth < SCROLL_ANCHOR_MAX_DEPTH && element.children.length > 0) {
      const deeper = pickScrollAnchorElement(element, containerTop, depth + 1);
      if (deeper) return deeper;
    }

    // Nothing inside it starts below the edge, so the next sibling is the
    // closest thing that does — it begins where this element ends.
    return element.nextElementSibling ?? element;
  }

  return null;
}

/* ------------------------------------------------------------------ */
/*  Helper: Convert a ChatMessage to a NormalizedMessage for the store */
/* ------------------------------------------------------------------ */

function chatMessageToNormalized(
  msg: ChatMessage,
  sessionId: string,
  provider: LLMProvider,
): NormalizedMessage | null {
  const id = `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const ts = msg.timestamp instanceof Date
    ? msg.timestamp.toISOString()
    : typeof msg.timestamp === 'number'
      ? new Date(msg.timestamp).toISOString()
      : String(msg.timestamp);
  const base = { id, sessionId, timestamp: ts, provider };

  if (msg.isToolUse) {
    return {
      ...base,
      kind: 'tool_use',
      toolName: msg.toolName,
      toolInput: msg.toolInput,
      toolId: msg.toolId || id,
    } as NormalizedMessage;
  }
  if (msg.isThinking) {
    return { ...base, kind: 'thinking', content: msg.content || '' } as NormalizedMessage;
  }
  if (msg.isInteractivePrompt) {
    return { ...base, kind: 'interactive_prompt', content: msg.content || '' } as NormalizedMessage;
  }
  if ((msg as any).isTaskNotification) {
    return {
      ...base,
      kind: 'task_notification',
      status: (msg as any).taskStatus || 'completed',
      summary: msg.content || '',
    } as NormalizedMessage;
  }
  if (msg.type === 'error') {
    return { ...base, kind: 'error', content: msg.content || '' } as NormalizedMessage;
  }
  return {
    ...base,
    kind: 'text',
    role: msg.type === 'user' ? 'user' : 'assistant',
    content: msg.content || '',
    // Keep attachment references on the local echo so the user bubble shows
    // its images immediately, before the server-backed copy replaces it.
    images: Array.isArray(msg.images) && msg.images.length > 0 ? msg.images : undefined,
  } as NormalizedMessage;
}

/* ------------------------------------------------------------------ */
/*  Hook                                                              */
/* ------------------------------------------------------------------ */

export function useChatSessionState({
  selectedProject,
  selectedSession,
  ws,
  sendMessage,
  externalMessageUpdate,
  newSessionTrigger,
  processingSessions,
  onSessionIdle,
  resetStreamingState,
  statusCheckSentAtRef,
  lastSeqRef,
  sessionStore,
}: UseChatSessionStateArgs) {
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(selectedSession?.id || null);
  const [isLoadingSessionMessages, setIsLoadingSessionMessages] = useState(false);
  const [isLoadingMoreMessages, setIsLoadingMoreMessages] = useState(false);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [totalMessages, setTotalMessages] = useState(0);
  const [isUserScrolledUp, setIsUserScrolledUp] = useState(false);
  // Drives the floating scroll-to-bottom button (see SCROLL_TO_BOTTOM_BUTTON_PX).
  const [isFarFromBottom, setIsFarFromBottom] = useState(false);
  const [tokenBudget, setTokenBudget] = useState<Record<string, unknown> | null>(null);
  // Authoritative context-window reading from the live runtime. Null until a
  // turn runs for this session; the gauge falls back to estimating from
  // `tokenBudget` (transcript usage) until then.
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);
  const [visibleMessageCount, setVisibleMessageCount] = useState(INITIAL_VISIBLE_MESSAGES);
  const [allMessagesLoaded, setAllMessagesLoaded] = useState(false);
  const [isLoadingAllMessages, setIsLoadingAllMessages] = useState(false);
  const [loadAllJustFinished, setLoadAllJustFinished] = useState(false);
  const [showLoadAllOverlay, setShowLoadAllOverlay] = useState(false);
  const [viewHiddenCount, setViewHiddenCount] = useState(0);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const wasNearTopRef = useRef(false);
  const [searchTarget, setSearchTarget] = useState<{ timestamp?: string; uuid?: string; snippet?: string } | null>(null);
  const searchScrollActiveRef = useRef(false);
  const isLoadingSessionRef = useRef(false);
  const isLoadingMoreRef = useRef(false);
  // Guards the self-heal backstop so it re-fetches at most once per stuck
  // episode (keyed by session id) instead of looping. Reset once the view
  // recovers, so a later stuck episode in the same session can heal again.
  const selfHealRefetchedRef = useRef<string | null>(null);
  const allMessagesLoadedRef = useRef(false);
  const topLoadLockRef = useRef(false);
  // Held only while the reader is up in the history; null means they are at the
  // bottom following the run, where the anchor is the bottom itself.
  const scrollAnchorRef = useRef<ScrollAnchor | null>(null);
  const pendingInitialScrollRef = useRef(true);
  const messagesOffsetRef = useRef(0);
  // Last observed scrollTop, so a scroll event can tell which way the reader
  // moved. Height changes (a prepended page, content settling) move scrollTop
  // too, but never in a way that reads as "scrolled up" while at the bottom —
  // the follow check below is evaluated first.
  const lastScrollTopRef = useRef(0);
  const loadAllFinishedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadAllOverlayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastLoadedSessionKeyRef = useRef<string | null>(null);
  /**
   * Tracks the last processed value from `useProjectsState.newSessionTrigger`.
   *
   * The trigger itself is intentionally increment-only and routed via:
   * useProjectsState -> AppContent -> MainContent -> ChatInterface -> this hook.
   * We compare values to ensure each explicit New Session click runs exactly one
   * reset pass in this local chat state domain.
   */
  const previousNewSessionTriggerRef = useRef(newSessionTrigger ?? 0);

  const createDiff = useMemo<DiffCalculator>(() => createCachedDiffCalculator(), []);

  useEffect(() => {
    const trigger = newSessionTrigger ?? 0;
    if (trigger === previousNewSessionTriggerRef.current) {
      return;
    }
    previousNewSessionTriggerRef.current = trigger;

    /**
     * Consumer-side reset for explicit New Session intent.
     *
     * Why this is essential:
     * - Chat keeps local state that is not fully derived from `selectedSession`:
     *   `currentSessionId`, `pendingUserMessage`, streaming/status flags, message
     *   pagination/scroll bookkeeping, and provider-specific sessionStorage keys.
     * - If the user clicks New Session while already on the same route with no
     *   selected session, parent state updates can be idempotent and this local
     *   state would otherwise persist, making the click appear to "do nothing".
     *
     * What this reset guarantees:
     * - A deterministic clean draft state on every New Session click.
     * - No dependence on route/tab/session-object identity changes.
     * - No coupling to unrelated external update signals.
     */
    resetStreamingState();
    setCurrentSessionId(null);
    setPendingUserMessage(null);
    messagesOffsetRef.current = 0;
    setHasMoreMessages(false);
    setTotalMessages(0);
    
    setTokenBudget(null);
    setContextUsage(null);
    setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
    setAllMessagesLoaded(false);
    allMessagesLoadedRef.current = false;
    setIsLoadingAllMessages(false);
    setLoadAllJustFinished(false);
    setShowLoadAllOverlay(false);
    setViewHiddenCount(0);
    setSearchTarget(null);
    wasNearTopRef.current = false;
    searchScrollActiveRef.current = false;
    topLoadLockRef.current = false;
    scrollAnchorRef.current = null;
    pendingInitialScrollRef.current = true;
    lastLoadedSessionKeyRef.current = null;

    if (loadAllOverlayTimerRef.current) {
      clearTimeout(loadAllOverlayTimerRef.current);
      loadAllOverlayTimerRef.current = null;
    }
    if (loadAllFinishedTimerRef.current) {
      clearTimeout(loadAllFinishedTimerRef.current);
      loadAllFinishedTimerRef.current = null;
    }
  }, [newSessionTrigger, onSessionIdle, resetStreamingState]);

  /* ---------------------------------------------------------------- */
  /*  Derive processing state for the viewed session                  */
  /* ---------------------------------------------------------------- */

  const activeSessionId = selectedSession?.id || currentSessionId || null;

  // The activity indicator always reflects the latest status of the session
  // being viewed — never stale local UI state from the last time it was
  // open. Session ids are concrete before any send, so no pending
  // placeholder entry exists anymore.
  const sessionActivity = (activeSessionId && processingSessions?.get(activeSessionId)) || null;
  const isProcessing = sessionActivity !== null;
  const canAbortSession = isProcessing && sessionActivity.canInterrupt;

  // Ref mirror so effects can read the latest map without re-running on
  // every activity transition.
  const processingSessionsRef = useRef(processingSessions);
  processingSessionsRef.current = processingSessions;

  /* ---------------------------------------------------------------- */
  /*  Derive chatMessages from the store                              */
  /* ---------------------------------------------------------------- */
  const [pendingUserMessage, setPendingUserMessage] = useState<ChatMessage | null>(null);
  const flushedPendingUserMessageRef = useRef<ChatMessage | null>(null);

  // Tell the store which session we're viewing so it only re-renders for this one
  const prevActiveForStoreRef = useRef<string | null>(null);
  if (activeSessionId !== prevActiveForStoreRef.current) {
    prevActiveForStoreRef.current = activeSessionId;
    sessionStore.setActiveSession(activeSessionId);
  }

  useEffect(() => {
    if (!pendingUserMessage) {
      flushedPendingUserMessageRef.current = null;
      return;
    }

    if (!activeSessionId) {
      return;
    }

    if (flushedPendingUserMessageRef.current === pendingUserMessage) {
      return;
    }

    const prov = (localStorage.getItem('selected-provider') as LLMProvider) || 'claude';
    const normalized = chatMessageToNormalized(pendingUserMessage, activeSessionId, prov);
    if (normalized) {
      sessionStore.appendRealtime(activeSessionId, normalized);
    }

    flushedPendingUserMessageRef.current = pendingUserMessage;
    setPendingUserMessage(null);
  }, [activeSessionId, pendingUserMessage, sessionStore]);

  const storeMessages = activeSessionId ? sessionStore.getMessages(activeSessionId) : [];

  // Reset viewHiddenCount when store messages change
  const prevStoreLenRef = useRef(0);
  if (storeMessages.length !== prevStoreLenRef.current) {
    prevStoreLenRef.current = storeMessages.length;
    if (viewHiddenCount > 0) setViewHiddenCount(0);
  }

  const chatMessages = useMemo(() => {
    const all = normalizedToChatMessages(storeMessages);
    // Show pending user message when no session data exists yet (new session, pre-backend-response)
    if (pendingUserMessage && all.length === 0) {
      return [pendingUserMessage];
    }
    if (viewHiddenCount > 0 && viewHiddenCount < all.length) return all.slice(0, -viewHiddenCount);
    return all;
  }, [storeMessages, viewHiddenCount, pendingUserMessage]);

  // Last history fetch for the visible session failed and nothing is rendered —
  // drives an explicit retryable error state instead of the misleading
  // "Continue your conversation" empty screen.
  const historyLoadFailed = Boolean(
    activeSessionId
    && storeMessages.length === 0
    && sessionStore.getSessionSlot(activeSessionId)?.status === 'error',
  );

  // The transcript file for this session no longer exists on disk (Claude
  // Code's auto-cleanup) — show an explanatory notice instead of the
  // "start a new conversation" empty state.
  const historyTranscriptMissing = Boolean(
    activeSessionId
    && storeMessages.length === 0
    && sessionStore.getSessionSlot(activeSessionId)?.transcriptMissing,
  );

  const retryLoadMessages = useCallback(() => {
    if (!activeSessionId) return;
    setIsLoadingSessionMessages(true);
    void sessionStore.fetchFromServer(activeSessionId, {
      limit: MESSAGES_PER_PAGE,
      offset: 0,
    }).then(slot => {
      if (slot) {
        setHasMoreMessages(slot.hasMore);
        setTotalMessages(slot.total);
      }
    }).finally(() => {
      setIsLoadingSessionMessages(false);
    });
  }, [activeSessionId, sessionStore]);

  /* ---------------------------------------------------------------- */
  /*  addMessage / clearMessages / rewindMessages                     */
  /* ---------------------------------------------------------------- */

  const addMessage = useCallback((msg: ChatMessage) => {
    if (!activeSessionId) {
      // No session yet — show as pending until the backend creates one
      setPendingUserMessage(msg);
      return;
    }
    const prov = (localStorage.getItem('selected-provider') as LLMProvider) || 'claude';
    const normalized = chatMessageToNormalized(msg, activeSessionId, prov);
    if (normalized) {
      sessionStore.appendRealtime(activeSessionId, normalized);
    }
  }, [activeSessionId, sessionStore]);

  const clearMessages = useCallback(() => {
    if (!activeSessionId) return;
    sessionStore.clearRealtime(activeSessionId);
  }, [activeSessionId, sessionStore]);

  const rewindMessages = useCallback((count: number) => setViewHiddenCount(count), []);

  const scrollToBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
    // Ours, not the reader's — see the scroll handler.
    lastScrollTopRef.current = container.scrollTop;
  }, []);

  const scrollToBottomAndReset = useCallback(() => {
    scrollToBottom();
    if (allMessagesLoaded) {
      setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
      setAllMessagesLoaded(false);
      allMessagesLoadedRef.current = false;
    }
  }, [allMessagesLoaded, scrollToBottom]);

  const isNearBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return false;
    const { scrollTop, scrollHeight, clientHeight } = container;
    return scrollHeight - scrollTop - clientHeight < 50;
  }, []);

  /**
   * The element wrapping the rendered messages, held as state rather than a ref
   * so the observer below attaches the moment the pane mounts it.
   */
  const [transcriptList, setTranscriptList] = useState<HTMLElement | null>(null);
  const transcriptListRef = useCallback((node: HTMLElement | null) => setTranscriptList(node), []);

  /**
   * Remembers the topmost message still on screen, and where on screen it is.
   *
   * Called on every scroll event, so the anchor is never more than a frame old.
   * The pane goes out of its way to keep React keys stable across a prepend
   * precisely so the element survives one and can still be measured.
   */
  const recordScrollAnchor = useCallback(() => {
    const container = scrollContainerRef.current;
    const list = transcriptList;
    if (!container || !list) return;

    const containerTop = container.getBoundingClientRect().top;
    const element = pickScrollAnchorElement(list, containerTop, 0);
    scrollAnchorRef.current = element
      ? { element, offset: element.getBoundingClientRect().top - containerTop }
      : null;
  }, [transcriptList]);

  /**
   * Puts the anchored message back where the reader had it.
   *
   * This is scroll anchoring, done by hand. Chrome and Firefox do it themselves
   * — content that grows above the viewport shifts nothing, because the browser
   * silently corrects the scroll offset. WebKit implements none of it (there is
   * no `overflow-anchor` in Safari, on the desktop or on iOS, where every
   * browser is WebKit underneath), so there the transcript jumped under the
   * reader every time anything above them changed height.
   *
   * Safe to call anywhere, in any browser: it measures the drift that actually
   * happened, so it corrects exactly what is wrong and does nothing when a
   * browser has already corrected it.
   */
  const restoreScrollAnchor = useCallback(() => {
    const container = scrollContainerRef.current;
    const anchor = scrollAnchorRef.current;
    if (!container || !anchor) return;

    // The anchor can be an element inside a message, which a re-render is free
    // to replace. A detached one cannot be measured, so take a fresh one now
    // rather than wait for the next scroll event: content settles while the
    // reader holds still, and no scroll event is coming to re-arm us.
    if (!anchor.element.isConnected) {
      recordScrollAnchor();
      return;
    }

    const containerTop = container.getBoundingClientRect().top;
    const drift = anchor.element.getBoundingClientRect().top - containerTop - anchor.offset;
    // Sub-pixel drift is layout rounding, not movement. Correcting it would
    // write to scrollTop on every resize for no visible gain.
    if (Math.abs(drift) < 1) return;

    container.scrollTop += drift;
    // Claim the scroll event this write will fire, so the handler doesn't read
    // it as the reader moving and re-anchor to it.
    lastScrollTopRef.current = container.scrollTop;
  }, [recordScrollAnchor]);

  const loadOlderMessages = useCallback(
    async (container: HTMLDivElement) => {
      if (!container || isLoadingMoreRef.current || isLoadingMoreMessages) return false;
      if (allMessagesLoadedRef.current) return false;
      if (!hasMoreMessages || !selectedSession || !selectedProject) return false;

      isLoadingMoreRef.current = true;

      try {
        const slot = await sessionStore.fetchMore(selectedSession.id, {
          limit: MESSAGES_PER_PAGE,
        });
        if (!slot) return false;
        if (slot.serverMessages.length === 0) {
          if (!slot.hasMore) {
            setHasMoreMessages(false);
            allMessagesLoadedRef.current = true;
            setAllMessagesLoaded(true);
            if (loadAllOverlayTimerRef.current) {
              clearTimeout(loadAllOverlayTimerRef.current);
              loadAllOverlayTimerRef.current = null;
            }
            setShowLoadAllOverlay(false);
          }
          return false;
        }

        setHasMoreMessages(slot.hasMore);
        setTotalMessages(slot.total);
        setVisibleMessageCount((prev) => prev + MESSAGES_PER_PAGE);
        if (!slot.hasMore) {
          allMessagesLoadedRef.current = true;
          setAllMessagesLoaded(true);
          if (loadAllOverlayTimerRef.current) {
            clearTimeout(loadAllOverlayTimerRef.current);
            loadAllOverlayTimerRef.current = null;
          }
          setShowLoadAllOverlay(false);
        }
        return true;
      } finally {
        isLoadingMoreRef.current = false;
      }
    },
    [hasMoreMessages, isLoadingMoreMessages, selectedProject, selectedSession, sessionStore],
  );

  const handleScroll = useCallback(async () => {
    const container = scrollContainerRef.current;
    if (!container) return;

    // Following is lost by intent and regained by arriving at the bottom: any
    // upward movement stops auto-scroll (even a few pixels), and only actually
    // reaching the bottom resumes it. A distance threshold can't express that —
    // it would resume following while the reader is still reading.
    const { scrollTop, scrollHeight, clientHeight } = container;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    const movedUp = scrollTop < lastScrollTopRef.current - 1;
    const moved = scrollTop !== lastScrollTopRef.current;
    lastScrollTopRef.current = scrollTop;

    if (distanceFromBottom <= FOLLOW_BOTTOM_PX) {
      setIsUserScrolledUp(false);
    } else if (movedUp) {
      setIsUserScrolledUp(true);
    }
    setIsFarFromBottom(distanceFromBottom > SCROLL_TO_BOTTOM_BUTTON_PX);

    // Re-anchor as the reader moves, so a correction that happens a moment
    // later restores the place they have *now* and not the one they had when
    // the last page was requested. At the bottom there is nothing to anchor:
    // the follow-the-bottom effect owns the position there.
    //
    // Only when `scrollTop` actually changed, though. A scroll event fires
    // early in the frame, before resize observations are delivered, so a
    // leftover event from a scroll already accounted for can arrive *after*
    // content above the reader has changed height but before the correction
    // for it — re-anchoring there would record the shifted position as the
    // wanted one and bake the jump in. Content moving under a still viewport
    // never changes `scrollTop`; the reader moving always does.
    if (distanceFromBottom <= FOLLOW_BOTTOM_PX) {
      scrollAnchorRef.current = null;
    } else if (moved || !scrollAnchorRef.current) {
      recordScrollAnchor();
    }

    const scrolledNearTop = container.scrollTop < 100;

    // "Load all" prompt: appear (with fade-in) when the user reaches the top
    if (scrolledNearTop && hasMoreMessages && !allMessagesLoadedRef.current) {
      if (!wasNearTopRef.current) {
        wasNearTopRef.current = true;
        if (loadAllOverlayTimerRef.current) clearTimeout(loadAllOverlayTimerRef.current);

        setShowLoadAllOverlay(true);
        loadAllOverlayTimerRef.current = setTimeout(() => {
          setShowLoadAllOverlay(false);
          loadAllOverlayTimerRef.current = null;
        }, 2500);
      }
    } else if (!scrolledNearTop) {
      wasNearTopRef.current = false;
    }

    if (!allMessagesLoadedRef.current) {
      if (!scrolledNearTop) { topLoadLockRef.current = false; return; }
      if (topLoadLockRef.current) {
        if (container.scrollTop > 20) topLoadLockRef.current = false;
        return;
      }
      const didLoad = await loadOlderMessages(container);
      if (didLoad) topLoadLockRef.current = true;
    }
  }, [hasMoreMessages, loadOlderMessages, recordScrollAnchor]);

  // Hold the reader's place across anything that changes the transcript's
  // layout: an older page prepended, a message rendered, a code block
  // highlighted, an image finally decoded. Runs before paint, so the correction
  // is never visible as a jump.
  useLayoutEffect(() => {
    restoreScrollAnchor();
  }, [chatMessages.length, visibleMessageCount, restoreScrollAnchor]);

  // A commit is only the start of the layout changes: markdown, syntax
  // highlighting and images settle over the frames that follow, and each of
  // them moves everything below by however much they grew. React has nothing to
  // say about those, so watch the list itself.
  useEffect(() => {
    if (!transcriptList || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(() => restoreScrollAnchor());
    observer.observe(transcriptList);
    return () => observer.disconnect();
  }, [restoreScrollAnchor, transcriptList]);

  // Reset scroll/pagination state on session change
  useEffect(() => {
    if (!searchScrollActiveRef.current) {
      pendingInitialScrollRef.current = true;
      setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
    }
    topLoadLockRef.current = false;
    scrollAnchorRef.current = null;
    wasNearTopRef.current = false;
    lastScrollTopRef.current = 0;
    setIsUserScrolledUp(false);
    setIsFarFromBottom(false);
  }, [selectedProject?.projectId, selectedSession?.id]);

  // Initial scroll to bottom — robust to lazy content reflow.
  // The previous implementation fired one scrollToBottom() at +200ms and
  // cleared the pending flag. When markdown blocks, code highlighting, or
  // images finished rendering after that window, scrollHeight grew but
  // nothing re-anchored the viewport, leaving the chat tab visually
  // "scrolled way up" with the latest assistant message off-screen.
  //
  // This version re-scrolls every animation frame while scrollHeight is
  // still growing, capped at ~1s (60 frames) or 3 consecutive stable
  // frames. Cancels cleanly on session change via the pending flag.
  useEffect(() => {
    if (!pendingInitialScrollRef.current || !scrollContainerRef.current || isLoadingSessionMessages) return;
    if (chatMessages.length === 0) { pendingInitialScrollRef.current = false; return; }
    if (searchScrollActiveRef.current) { pendingInitialScrollRef.current = false; return; }

    const container = scrollContainerRef.current;
    let frame = 0;
    let lastHeight = 0;
    let stableCount = 0;
    let rafId = 0;

    const tick = () => {
      if (!pendingInitialScrollRef.current || !scrollContainerRef.current) return;
      container.scrollTop = container.scrollHeight;
      lastScrollTopRef.current = container.scrollTop;
      if (container.scrollHeight === lastHeight) {
        stableCount++;
      } else {
        stableCount = 0;
        lastHeight = container.scrollHeight;
      }
      frame++;
      if (stableCount < 3 && frame < 60) {
        rafId = requestAnimationFrame(tick);
      } else {
        pendingInitialScrollRef.current = false;
      }
    };
    rafId = requestAnimationFrame(tick);
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [chatMessages.length, isLoadingSessionMessages, scrollToBottom]);

  // Main session loading effect — store-based
  useEffect(() => {
    if (!selectedSession || !selectedProject) {
      // A freshly created session can be mid-run before the router has a
      // canonical selectedSession (the URL effect synthesizes one on the
      // next render). Keep the active view intact instead of wiping it.
      if (currentSessionId && processingSessionsRef.current?.has(currentSessionId)) {
        return;
      }

      resetStreamingState();
      setCurrentSessionId(null);
      messagesOffsetRef.current = 0;
      setHasMoreMessages(false);
      setTotalMessages(0);
      setTokenBudget(null);
      setContextUsage(null);
      lastLoadedSessionKeyRef.current = null;
      return;
    }

    const selectedSessionId = selectedSession.id;
    const sessionKey = `${selectedSessionId}:${selectedProject.projectId}`;

    const subscribeToSelectedSession = () => {
      if (!ws) {
        return;
      }

      statusCheckSentAtRef.current.set(selectedSessionId, Date.now());
      sendMessage({
        type: 'chat.subscribe',
        sessions: [{
          sessionId: selectedSessionId,
          lastSeq: lastSeqRef.current.get(selectedSessionId) ?? 0,
        }],
      });
    };

    // Skip if already loaded and fresh
    if (lastLoadedSessionKeyRef.current === sessionKey && sessionStore.has(selectedSessionId) && !sessionStore.isStale(selectedSessionId)) {
      subscribeToSelectedSession();
      return;
    }

    const sessionChanged = currentSessionId !== null && currentSessionId !== selectedSessionId;
    if (sessionChanged) {
      resetStreamingState();
    }

    // Reset pagination/scroll state
    messagesOffsetRef.current = 0;
    setHasMoreMessages(false);
    setTotalMessages(0);
    setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
    setAllMessagesLoaded(false);
    allMessagesLoadedRef.current = false;
    setIsLoadingAllMessages(false);
    setLoadAllJustFinished(false);
    setShowLoadAllOverlay(false);
    setViewHiddenCount(0);
    wasNearTopRef.current = false;
    if (loadAllOverlayTimerRef.current) clearTimeout(loadAllOverlayTimerRef.current);
    if (loadAllFinishedTimerRef.current) clearTimeout(loadAllFinishedTimerRef.current);

    if (sessionChanged) {
      setTokenBudget(null);
      // Belongs to the session we just left; the new one reports its own.
      setContextUsage(null);
    }

    setCurrentSessionId(selectedSessionId);

    // Subscribe to the session's live run (if any): the ack reconciles the
    // processing indicator, re-attaches a mid-flight stream to this socket,
    // and replays any live events missed since `lastSeq`. Recording the send
    // time lets the ack handler discard idle acks that a newer request has
    // since outdated.
    subscribeToSelectedSession();

    lastLoadedSessionKeyRef.current = sessionKey;

    // Fetch from server → store updates → chatMessages re-derives automatically
    setIsLoadingSessionMessages(true);
    sessionStore.fetchFromServer(selectedSessionId, {
      limit: MESSAGES_PER_PAGE,
      offset: 0,
    }).then(slot => {
      if (slot) {
        setHasMoreMessages(slot.hasMore);
        setTotalMessages(slot.total);
        if (slot.tokenUsage) setTokenBudget(slot.tokenUsage as Record<string, unknown>);
      }
      setIsLoadingSessionMessages(false);
    }).catch(() => {
      setIsLoadingSessionMessages(false);
    });
  }, [
    resetStreamingState,
    selectedProject,
    selectedSession?.id,
    sendMessage,
    statusCheckSentAtRef,
    lastSeqRef,
    ws,
    sessionStore,
  ]);

  // External message update (e.g. WebSocket reconnect, background refresh)
  useEffect(() => {
    if (!externalMessageUpdate || !selectedSession || !selectedProject) return;

    const reloadExternalMessages = async () => {
      try {
        // Skip store refresh during active streaming
        if (!isProcessing) {
          await sessionStore.refreshFromServer(selectedSession.id);

          if (isNearBottom()) {
            setTimeout(() => scrollToBottom(), 200);
          }
        }
      } catch (error) {
        console.error('Error reloading messages from external update:', error);
      }
    };

    reloadExternalMessages();
  }, [
    externalMessageUpdate,
    isNearBottom,
    scrollToBottom,
    selectedProject,
    selectedSession,
    sessionStore,
    isProcessing,
  ]);

  // Self-heal a stuck-empty chat. The pane renders purely from the store's
  // merged list, but that list can be emptied mid-session without an automatic
  // refetch: a WS reconnect during an active run skips the external refresh
  // above (it bails while `isProcessing`), and an optimistic rewind truncates
  // `serverMessages`. The only other recovery is the run's terminal `complete`
  // event, so a long-running session in a long-lived tab could stay blank until
  // a manual reload (the shell view is unaffected — it never reads history).
  // When the server reports a non-empty transcript (`total > 0`) but we're
  // rendering nothing, re-fetch once — exactly what a manual reload does.
  useEffect(() => {
    if (!selectedSession || !selectedProject) return;

    const sid = selectedSession.id;
    const slot = sessionStore.getSessionSlot(sid);
    const mergedLen = slot?.merged.length ?? 0;

    if (mergedLen > 0) {
      // Healthy again — re-arm the backstop for any future stuck episode.
      selfHealRefetchedRef.current = null;
      return;
    }

    // The initial load owns the empty window; don't race it.
    if (isLoadingSessionMessages || isLoadingMoreMessages) return;

    // Act when the server says there IS a transcript to show (`total > 0`), or
    // when the last fetch failed outright (`status === 'error'`, so `total` is
    // a meaningless 0 — e.g. a transient network drop or a 5xx). A genuinely
    // empty session (successful fetch, `total === 0`) is correctly blank.
    if (!slot) return;
    if (slot.total <= 0 && slot.status !== 'error') return;

    if (selfHealRefetchedRef.current === sid) return;
    selfHealRefetchedRef.current = sid;
    void sessionStore.refreshFromServer(sid);
  }, [
    chatMessages.length,
    isLoadingMoreMessages,
    isLoadingSessionMessages,
    selectedProject,
    selectedSession,
    sessionStore,
  ]);

  // Search navigation target
  useEffect(() => {
    const session = selectedSession as Record<string, unknown> | null;
    const targetSnippet = session?.__searchTargetSnippet;
    const targetTimestamp = session?.__searchTargetTimestamp;
    if (typeof targetSnippet === 'string' && targetSnippet) {
      searchScrollActiveRef.current = true;
      setSearchTarget({
        snippet: targetSnippet,
        timestamp: typeof targetTimestamp === 'string' ? targetTimestamp : undefined,
      });
    }
  }, [selectedSession]);

  // Scroll to search target
  useEffect(() => {
    if (!searchTarget || chatMessages.length === 0 || isLoadingSessionMessages) return;

    const target = searchTarget;
    setSearchTarget(null);

    const scrollToTarget = async () => {
      if (!allMessagesLoadedRef.current && selectedSession && selectedProject) {
          try {
            // Load all messages into the store for search navigation
            const slot = await sessionStore.fetchFromServer(selectedSession.id, {
              limit: null,
              offset: 0,
            });
            if (slot) {
              setHasMoreMessages(false);
              setTotalMessages(slot.total);
              messagesOffsetRef.current = slot.total;
              setVisibleMessageCount(Infinity);
              setAllMessagesLoaded(true);
              allMessagesLoadedRef.current = true;
              await new Promise(resolve => setTimeout(resolve, 300));
            }
          } catch {
            // Fall through and scroll in current messages
          }
      }
      setVisibleMessageCount(Infinity);

      const findAndScroll = (retriesLeft: number) => {
        const container = scrollContainerRef.current;
        if (!container) return;

        let targetElement: Element | null = null;

        if (target.snippet) {
          const cleanSnippet = target.snippet.replace(/^\.{3}/, '').replace(/\.{3}$/, '').trim();
          const searchPhrase = cleanSnippet.slice(0, 80).toLowerCase().trim();
          if (searchPhrase.length >= 10) {
            const messageElements = container.querySelectorAll('.chat-message');
            for (const el of messageElements) {
              const text = (el.textContent || '').toLowerCase();
              if (text.includes(searchPhrase)) { targetElement = el; break; }
            }
          }
        }

        if (!targetElement && target.timestamp) {
          const targetDate = new Date(target.timestamp).getTime();
          const messageElements = container.querySelectorAll('[data-message-timestamp]');
          let closestDiff = Infinity;
          for (const el of messageElements) {
            const ts = el.getAttribute('data-message-timestamp');
            if (!ts) continue;
            const diff = Math.abs(new Date(ts).getTime() - targetDate);
            if (diff < closestDiff) { closestDiff = diff; targetElement = el; }
          }
        }

        if (targetElement) {
          targetElement.scrollIntoView({ block: 'center', behavior: 'smooth' });
          targetElement.classList.add('search-highlight-flash');
          setTimeout(() => targetElement?.classList.remove('search-highlight-flash'), 4000);
          searchScrollActiveRef.current = false;
        } else if (retriesLeft > 0) {
          setTimeout(() => findAndScroll(retriesLeft - 1), 200);
        } else {
          searchScrollActiveRef.current = false;
        }
      };

      setTimeout(() => findAndScroll(15), 150);
    };

    scrollToTarget();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatMessages.length, isLoadingSessionMessages, searchTarget]);

  // Initial token usage fetch for providers with file-backed usage data.
  useEffect(() => {
    if (!selectedProject || !selectedSession?.id) {
      setTokenBudget(null);
      setContextUsage(null);
      return;
    }
    const fetchInitialTokenUsage = async () => {
      try {
        // The backend resolves the provider from the indexed session row.
        const url = `/api/projects/${selectedProject.projectId}/sessions/${selectedSession.id}/token-usage`;
        const response = await authenticatedFetch(url);
        if (response.ok) {
          const usage = await response.json();
          setTokenBudget(usage);
          // The server hands back its last live reading for this session when
          // it still has one, which restores the full gauge (percentage,
          // auto-compact state) across a reload without waiting for a turn.
          setContextUsage(usage?.contextUsage ?? null);
        } else {
          setTokenBudget(null);
          setContextUsage(null);
        }
      } catch (error) {
        console.error('Failed to fetch initial token usage:', error);
      }
    };
    fetchInitialTokenUsage();
  }, [selectedProject, selectedSession?.id]);

  const visibleMessages = useMemo(() => {
    if (chatMessages.length <= visibleMessageCount) return chatMessages;
    return chatMessages.slice(-visibleMessageCount);
  }, [chatMessages, visibleMessageCount]);

  /**
   * Keeps the top edge of the visible window where it is while a session runs.
   *
   * The window is the *last* `visibleMessageCount` messages, so every message a
   * running session produces pushes one off the top of it. That deletes content
   * from above the viewport — the transcript slides up under a reader who is
   * back in the history by however tall the dropped message was, once per
   * message, for as long as the agent keeps working. Growing the window by as
   * much as the transcript grew leaves everything above the reader untouched,
   * which is cheaper and steadier than moving the viewport to compensate.
   *
   * Only appends count. A prepended page changes the first message, and the
   * window is measured from the end, so it needs no adjustment.
   */
  const firstMessageKey = chatMessages.length > 0 ? getIntrinsicMessageKey(chatMessages[0]) : null;
  const transcriptEndRef = useRef<{ firstKey: string | null; length: number }>({ firstKey: null, length: 0 });
  if (
    transcriptEndRef.current.firstKey !== firstMessageKey
    || transcriptEndRef.current.length !== chatMessages.length
  ) {
    const previous = transcriptEndRef.current;
    transcriptEndRef.current = { firstKey: firstMessageKey, length: chatMessages.length };

    // An anchor is held exactly when the reader is somewhere above the bottom,
    // which is exactly when losing a message off the top would be visible.
    // Adjusted during the render that grew the transcript rather than in an
    // effect afterwards, so the message is never dropped and put back — a
    // committed removal would shift the view and need correcting twice over.
    const appended = previous.firstKey === firstMessageKey ? chatMessages.length - previous.length : 0;
    if (appended > 0 && scrollAnchorRef.current) {
      setVisibleMessageCount((count) => count + appended);
    }
  }

  // Follow the transcript while the view is pinned to the bottom. When it isn't,
  // leave the viewport alone: the reader's place is held by the scroll anchor
  // above, which measures the drift that actually happened instead of
  // re-deriving a position from a height delta — every version of that moved
  // the view out from under them instead.
  useEffect(() => {
    if (!scrollContainerRef.current || chatMessages.length === 0) return;
    if (isLoadingMoreRef.current || isLoadingMoreMessages) return;
    if (searchScrollActiveRef.current) return;
    if (isUserScrolledUp) return;

    setTimeout(() => scrollToBottom(), 50);
  }, [chatMessages.length, isLoadingMoreMessages, isUserScrolledUp, scrollToBottom]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  // "Load all" overlay visibility is driven by scroll-to-top in handleScroll;
  // timers are cleared on session change via the reset effect above.

  const loadAllMessages = useCallback(async () => {
    if (!selectedSession || !selectedProject) return;
    if (isLoadingAllMessages) return;
    const requestSessionId = selectedSession.id;
    allMessagesLoadedRef.current = true;
    isLoadingMoreRef.current = true;
    setIsLoadingAllMessages(true);
    setShowLoadAllOverlay(true);
    if (loadAllOverlayTimerRef.current) {
      clearTimeout(loadAllOverlayTimerRef.current);
      loadAllOverlayTimerRef.current = null;
    }

    try {
      const slot = await sessionStore.fetchFromServer(requestSessionId, {
        limit: null,
        offset: 0,
      });

      if (currentSessionId !== requestSessionId) return;

      if (slot) {
        setHasMoreMessages(false);
        setTotalMessages(slot.total);
        messagesOffsetRef.current = slot.total;
        setVisibleMessageCount(Infinity);
        setAllMessagesLoaded(true);

        setLoadAllJustFinished(true);
        if (loadAllFinishedTimerRef.current) clearTimeout(loadAllFinishedTimerRef.current);
        loadAllFinishedTimerRef.current = setTimeout(() => {
          setLoadAllJustFinished(false);
          setShowLoadAllOverlay(false);
          loadAllFinishedTimerRef.current = null;
        }, 2500);
      } else {
        allMessagesLoadedRef.current = false;
        setShowLoadAllOverlay(false);
      }
    } catch (error) {
      console.error('Error loading all messages:', error);
      allMessagesLoadedRef.current = false;
      setShowLoadAllOverlay(false);
    } finally {
      isLoadingMoreRef.current = false;
      setIsLoadingAllMessages(false);
    }
  }, [selectedSession, selectedProject, isLoadingAllMessages, currentSessionId, sessionStore]);

  const loadEarlierMessages = useCallback(() => {
    setVisibleMessageCount((prev) => prev + 100);
  }, []);

  return {
    chatMessages,
    addMessage,
    clearMessages,
    rewindMessages,
    sessionActivity,
    isProcessing,
    canAbortSession,
    currentSessionId,
    setCurrentSessionId,
    isLoadingSessionMessages,
    isLoadingMoreMessages,
    historyLoadFailed,
    historyTranscriptMissing,
    retryLoadMessages,
    hasMoreMessages,
    totalMessages,
    isUserScrolledUp,
    isFarFromBottom,
    setIsUserScrolledUp,
    tokenBudget,
    setTokenBudget,
    contextUsage,
    setContextUsage,
    visibleMessageCount,
    visibleMessages,
    loadEarlierMessages,
    loadAllMessages,
    allMessagesLoaded,
    isLoadingAllMessages,
    loadAllJustFinished,
    showLoadAllOverlay,
    createDiff,
    scrollContainerRef,
    transcriptListRef,
    scrollToBottom,
    scrollToBottomAndReset,
    isNearBottom,
    handleScroll,
  };
}
