import { useEffect, useRef, useState } from 'react';

/**
 * Loading the open session's model must not give up after one failure: the
 * composer would then fall back to the per-provider default and send it, and
 * the server records what a send carries — so one failed request right after a
 * restart silently moved a session onto another model.
 */

/** Waits between attempts; the last one repeats until the load succeeds. */
export const SESSION_MODEL_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

export function sessionModelRetryDelay(attempt: number): number {
  const index = Math.min(Math.max(attempt, 0), SESSION_MODEL_RETRY_DELAYS_MS.length - 1);
  return SESSION_MODEL_RETRY_DELAYS_MS[index];
}

type RetryOptions = {
  /** True once the caller no longer wants the answer (session switched, unmounted). */
  isCancelled: () => boolean;
  onError?: (error: unknown, attempt: number) => void;
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/**
 * Calls `load` until it succeeds or the caller cancels. Resolves `undefined`
 * when cancelled, so a stale answer can never be applied.
 */
export async function loadUntilSettled<T>(
  load: () => Promise<T>,
  { isCancelled, onError, sleep = defaultSleep }: RetryOptions,
): Promise<T | undefined> {
  for (let attempt = 0; !isCancelled(); attempt += 1) {
    try {
      const value = await load();
      return isCancelled() ? undefined : value;
    } catch (error) {
      if (isCancelled()) return undefined;
      onError?.(error, attempt);
      await sleep(sessionModelRetryDelay(attempt));
    }
  }
  return undefined;
}

/**
 * The model a send carries. A brand-new conversation has no session yet and
 * starts on the per-provider default (`undefined` lets the composer pick it).
 * An open session sends its own model once that has been read, and nothing
 * (`null`) before, so the server keeps what it recorded.
 */
export function sessionModelForSend(
  hasSession: boolean,
  resolved: boolean,
  sessionModel: string,
): string | null | undefined {
  if (!hasSession) return undefined;
  return resolved ? sessionModel : null;
}

/** The next reconnect count after the socket reports `isConnected`. */
export function nextReconnectEpoch(
  epoch: number,
  wasConnected: boolean | null,
  isConnected: boolean,
): number {
  return wasConnected === false && isConnected ? epoch + 1 : epoch;
}

/**
 * Counts reconnects of the chat socket: 0 until the first drop, then +1 each
 * time the socket comes back. Anything read over HTTP while the server was
 * away (a restart, a network drop) keys on it to be read again.
 */
export function useReconnectEpoch(isConnected: boolean): number {
  const [epoch, setEpoch] = useState(0);
  const wasConnectedRef = useRef<boolean | null>(null);
  useEffect(() => {
    const previous = wasConnectedRef.current;
    wasConnectedRef.current = isConnected;
    setEpoch((value) => nextReconnectEpoch(value, previous, isConnected));
  }, [isConnected]);
  return epoch;
}
