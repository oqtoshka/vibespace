/**
 * Classifies a failed OpenCode turn for the durable wake.
 *
 * OpenCode 1.18's server engine retries a provider failure twice within about a
 * second, then publishes `session.next.step.failed` with `{type: "unknown",
 * message}` — status, headers and the retryable flag are all gone by then. The
 * message text is the only signal left:
 *
 *   Provider request failed with HTTP 503: {"error":{"message":"…GPU is assigned to another workload…"}}
 *   Provider request failed with HTTP 502: <html>…Bad Gateway…
 *   HTTP transport failed
 *   Failed to read homelab/openai-compatible-chat stream
 *
 * A wake is worth it only when waiting can fix the failure: a rate limit, an
 * overloaded or busy upstream, a dropped connection. Auth errors, bad requests,
 * context overflow, exhausted quota and a user stop cannot be waited out.
 */
export type OpenCodeWakeKind = { recoveryKind: 'usage-limit' | 'provider-unavailable'; limitType: string };

const STATUS_PATTERN = /Provider request failed with HTTP (\d{3})/;
const QUOTA_PATTERN = /insufficient[-_\s]?quota|quota[-_\s]?exceeded|billing/i;
const WAITABLE_5XX = new Set([500, 502, 503, 504, 520, 521, 522, 523, 524, 529]);

export function classifyOpenCodeFailure(message: unknown): OpenCodeWakeKind | null {
  if (typeof message !== 'string' || !message) return null;

  const status = STATUS_PATTERN.exec(message);
  if (status) {
    const code = Number(status[1]);
    if (code === 429) {
      return QUOTA_PATTERN.test(message) ? null : { recoveryKind: 'usage-limit', limitType: 'http_429' };
    }
    if (code === 408 || WAITABLE_5XX.has(code)) {
      return { recoveryKind: 'provider-unavailable', limitType: `http_${code}` };
    }
    return null;
  }

  if (/^HTTP transport failed/i.test(message) || /Failed to read \S+ stream/i.test(message)) {
    return { recoveryKind: 'provider-unavailable', limitType: 'transport' };
  }
  return null;
}
