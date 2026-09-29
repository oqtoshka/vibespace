import { useCallback, useEffect, useRef, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import { loadUntilSettled } from '../utils/sessionModelLoad';
import type { LLMProvider } from '../../../types/app';

type SessionActiveModelResponse = {
  success?: boolean;
  data?: {
    model?: string;
    overridden?: boolean;
  };
};

type UseSessionActiveModelArgs = {
  provider: LLMProvider;
  sessionId: string | null;
  /** Per-provider picker default, used until (and unless) the session answers. */
  fallbackModel: string;
  /**
   * A turn is running. Model changes land on the session's next turn, so the
   * readout is re-read once the run finishes and the transcript catches up.
   */
  isProcessing: boolean;
  /** Bumps when the chat socket reconnects; the readout is read again then. */
  reconnectEpoch?: number;
};

/**
 * The model the visible session will actually run its next turn on.
 *
 * The per-provider model in localStorage is only the default for *new*
 * sessions: picking a model for an existing session writes a server-side
 * override instead, so a composer reading localStorage kept announcing the old
 * model no matter what the picker said. The server resolves override →
 * transcript → catalog default, and this hook mirrors that answer.
 */
export function useSessionActiveModel({
  provider,
  sessionId,
  fallbackModel,
  isProcessing,
  reconnectEpoch = 0,
}: UseSessionActiveModelArgs): { activeModel: string; resolved: boolean; refresh: () => void } {
  // Keyed by session, so another session's answer is never shown for this one.
  const [answer, setAnswer] = useState<{ sessionId: string; model: string | null } | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  const refresh = useCallback(() => {
    setRefreshToken((previous) => previous + 1);
  }, []);

  // Re-read once a run finishes: the turn may have consumed an override, or
  // the CLI's own `/model` may have switched models behind our back.
  const wasProcessingRef = useRef(isProcessing);
  useEffect(() => {
    const justFinished = wasProcessingRef.current && !isProcessing;
    wasProcessingRef.current = isProcessing;
    if (justFinished) {
      refresh();
    }
  }, [isProcessing, refresh]);

  useEffect(() => {
    const normalizedSessionId = sessionId?.trim();
    if (!normalizedSessionId) {
      // A brand-new conversation has no session to ask about — the provider
      // default is the truthful answer.
      setAnswer(null);
      return undefined;
    }

    let cancelled = false;

    void (async () => {
      // Retried until it answers; meanwhile the readout shows nothing rather
      // than the per-provider default, which may not be this session's model.
      const body = await loadUntilSettled(async () => {
        const response = await authenticatedFetch(
          `/api/providers/${provider}/sessions/${encodeURIComponent(normalizedSessionId)}/active-model`,
        );
        if (response.status >= 500) {
          throw new Error(`active-model answered ${response.status}`);
        }
        return (await response.json()) as SessionActiveModelResponse;
      }, { isCancelled: () => cancelled });
      if (!body || cancelled) return;
      setAnswer({ sessionId: normalizedSessionId, model: body.success ? body.data?.model || null : null });
    })();

    return () => {
      cancelled = true;
    };
  }, [provider, sessionId, refreshToken, reconnectEpoch]);

  const normalizedSessionId = sessionId?.trim() || null;
  const currentAnswer = normalizedSessionId && answer?.sessionId === normalizedSessionId ? answer : null;
  return {
    activeModel: currentAnswer?.model || fallbackModel,
    resolved: !normalizedSessionId || currentAnswer !== null,
    refresh,
  };
}
