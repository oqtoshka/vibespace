import { useCallback, useEffect, useRef, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';
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
}: UseSessionActiveModelArgs): { activeModel: string; refresh: () => void } {
  const [sessionModel, setSessionModel] = useState<string | null>(null);
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
      setSessionModel(null);
      return undefined;
    }

    let cancelled = false;

    void (async () => {
      try {
        const response = await authenticatedFetch(
          `/api/providers/${provider}/sessions/${encodeURIComponent(normalizedSessionId)}/active-model`,
        );
        const body = (await response.json()) as SessionActiveModelResponse;
        if (cancelled || !response.ok || !body.success || !body.data?.model) {
          return;
        }
        setSessionModel(body.data.model);
      } catch {
        // Keep whatever is on screen; the fallback already covers this.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [provider, sessionId, refreshToken]);

  return { activeModel: sessionModel || fallbackModel, refresh };
}
