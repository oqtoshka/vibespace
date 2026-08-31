import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { authenticatedFetch } from '../../../utils/api';
import { useWebSocket, useWebSocketEvent } from '../../../contexts/WebSocketContext';
import type { ServerEvent } from '../../../contexts/WebSocketContext';
import type { LLMProvider, Project } from '../../../types/app';

/**
 * Drives a `/btw` exchange — a quick question answered alongside the session
 * the user is watching, without disturbing it.
 *
 * The question runs against its own **side session**: a real, resumable
 * session in the same project and provider that the backend keeps out of the
 * session lists (`is_side`). Two things fall out of that choice:
 *
 * 1. Nothing is interrupted. A side session has its own session id, so it gets
 *    its own provider run. Sending it a message never touches the in-flight
 *    turn — which matters most for Claude, where reusing a live session id
 *    would call `interrupt()` on the turn the user is watching.
 * 2. It works for every harness. The exchange travels the ordinary `chat.send`
 *    path, so claude, codex, opencode and cursor are all supported by the same
 *    code, with no provider-specific one-shot mode to maintain.
 *
 * "Branching out" is then almost free: the answer already lives in a real
 * provider session, so promoting it (`POST …/promote`) turns the throwaway
 * question into an ordinary conversation with its context intact — nothing is
 * replayed and nothing is re-asked.
 */

export type BtwExchange = {
  id: string;
  question: string;
  answer: string;
  status: 'streaming' | 'done' | 'error';
  error?: string;
};

type UseBtwSessionOptions = {
  selectedProject: Project | null;
  provider: LLMProvider;
  model: string | undefined;
  /** Working directory of the visible session, so btw sees the same tree. */
  cwd: string;
};

// A btw is a question, not a task: reads are what make an answer useful, and
// everything that changes the workspace is denied. Sending the same deny list
// to every provider keeps the guarantee uniform even though each maps it onto
// a different mechanism underneath.
const BTW_DISALLOWED_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'Bash', 'Task'];

const createExchangeId = () =>
  `btw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export function useBtwSession({ selectedProject, provider, model, cwd }: UseBtwSessionOptions) {
  const { sendMessage } = useWebSocket();
  const { i18n } = useTranslation();
  const interfaceLanguage = i18n.resolvedLanguage || i18n.language || 'en';
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [exchanges, setExchanges] = useState<BtwExchange[]>([]);
  const [isPromoted, setIsPromoted] = useState(false);

  // The exchange currently accumulating streamed text. Frames arrive by
  // session id only, so the hook has to remember which question they answer.
  const activeExchangeRef = useRef<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  // A new project or provider invalidates the side session: it is bound to the
  // project path and provider it was allocated for.
  useEffect(() => {
    setSessionId(null);
    setExchanges([]);
    setIsPromoted(false);
    activeExchangeRef.current = null;
  }, [selectedProject?.projectId, provider]);

  const updateExchange = useCallback((id: string, patch: Partial<BtwExchange>) => {
    setExchanges((previous) =>
      previous.map((exchange) => (exchange.id === id ? { ...exchange, ...patch } : exchange)),
    );
  }, []);

  useWebSocketEvent(
    useCallback(
      (message: ServerEvent) => {
        const currentSessionId = sessionIdRef.current;
        const activeExchange = activeExchangeRef.current;
        if (!currentSessionId || !activeExchange) return;

        const payload = message as unknown as Record<string, unknown>;
        if (payload.sessionId !== currentSessionId) return;

        const kind = payload.kind;

        if (kind === 'text' || kind === 'stream_delta') {
          const content = typeof payload.content === 'string' ? payload.content : '';
          if (!content) return;
          setExchanges((previous) =>
            previous.map((exchange) =>
              exchange.id === activeExchange
                ? { ...exchange, answer: exchange.answer + content }
                : exchange,
            ),
          );
          return;
        }

        if (kind === 'complete') {
          const failed = payload.success === false && payload.aborted !== true;
          updateExchange(activeExchange, {
            status: failed ? 'error' : 'done',
            error: failed ? 'The provider ended this question without answering.' : undefined,
          });
          activeExchangeRef.current = null;
          return;
        }

        if (kind === 'error') {
          const errorText = typeof payload.error === 'string' ? payload.error : 'Something went wrong.';
          updateExchange(activeExchange, { status: 'error', error: errorText });
          activeExchangeRef.current = null;
        }
      },
      [updateExchange],
    ),
  );

  /**
   * Allocates the side session on first use, so merely opening the panel does
   * not create a session the user never asks anything in.
   */
  const ensureSessionId = useCallback(async (): Promise<string | null> => {
    if (sessionIdRef.current) return sessionIdRef.current;
    if (!selectedProject) return null;

    const projectPath = selectedProject.fullPath || selectedProject.path || '';
    const response = await authenticatedFetch('/api/providers/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, projectPath, side: true }),
    });

    if (!response.ok) {
      throw new Error('Could not start a side session for this question.');
    }

    const body = await response.json();
    const newSessionId = body?.data?.sessionId ?? body?.sessionId ?? null;
    if (!newSessionId) {
      throw new Error('The server did not return a side session id.');
    }

    sessionIdRef.current = newSessionId;
    setSessionId(newSessionId);
    return newSessionId;
  }, [provider, selectedProject]);

  const ask = useCallback(
    async (question: string) => {
      const trimmed = question.trim();
      if (!trimmed || activeExchangeRef.current) return;

      const exchangeId = createExchangeId();
      setExchanges((previous) => [
        ...previous,
        { id: exchangeId, question: trimmed, answer: '', status: 'streaming' },
      ]);
      activeExchangeRef.current = exchangeId;

      let targetSessionId: string | null = null;
      try {
        targetSessionId = await ensureSessionId();
      } catch (error) {
        updateExchange(exchangeId, {
          status: 'error',
          error: (error as Error)?.message || 'Could not start a side session.',
        });
        activeExchangeRef.current = null;
        return;
      }

      if (!targetSessionId) {
        updateExchange(exchangeId, { status: 'error', error: 'No project is selected.' });
        activeExchangeRef.current = null;
        return;
      }

      sendMessage({
        type: 'chat.send',
        sessionId: targetSessionId,
        clientMsgId: exchangeId,
        content: trimmed,
        options: {
          cwd,
          model,
          // Codex has no plan mode; the deny list below still applies, so the
          // downgrade costs nothing but an unsupported value would break it.
          permissionMode: provider === 'codex' ? 'default' : 'plan',
          toolsSettings: { disallowedTools: BTW_DISALLOWED_TOOLS },
          skipPermissions: false,
          sessionSummary: trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed,
          locale: interfaceLanguage,
          images: [],
        },
      });
    },
    [cwd, ensureSessionId, interfaceLanguage, model, provider, sendMessage, updateExchange],
  );

  const abort = useCallback(() => {
    const currentSessionId = sessionIdRef.current;
    const activeExchange = activeExchangeRef.current;
    if (!currentSessionId || !activeExchange) return;

    sendMessage({ type: 'chat.abort', sessionId: currentSessionId });
    updateExchange(activeExchange, { status: 'done' });
    activeExchangeRef.current = null;
  }, [sendMessage, updateExchange]);

  /**
   * Branches the side conversation out into a full session and returns its id
   * so the caller can navigate to it.
   */
  const promote = useCallback(async (): Promise<string | null> => {
    const currentSessionId = sessionIdRef.current;
    if (!currentSessionId) return null;

    const firstQuestion = exchanges[0]?.question ?? '';
    const name = firstQuestion.length > 60 ? `${firstQuestion.slice(0, 57)}...` : firstQuestion;

    const response = await authenticatedFetch(
      `/api/providers/sessions/${encodeURIComponent(currentSessionId)}/promote`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      },
    );

    if (!response.ok) return null;

    setIsPromoted(true);
    return currentSessionId;
  }, [exchanges]);

  const reset = useCallback(() => {
    setSessionId(null);
    setExchanges([]);
    setIsPromoted(false);
    activeExchangeRef.current = null;
    sessionIdRef.current = null;
  }, []);

  // Derived from state rather than the ref: a ref change does not re-render,
  // so a ref-based flag would leave the UI showing a finished question as
  // still streaming.
  const isStreaming = exchanges.some((exchange) => exchange.status === 'streaming');

  return {
    sessionId,
    exchanges,
    isStreaming,
    isPromoted,
    canPromote: Boolean(sessionId) && exchanges.length > 0 && !isPromoted,
    ask,
    abort,
    promote,
    reset,
  };
}

export default useBtwSession;
