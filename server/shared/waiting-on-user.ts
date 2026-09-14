/**
 * The waiting-on-user marker for ledgers that carry no metadata.
 *
 * Claude's tasks flag a parked item with TaskUpdate metadata. OpenCode's todos
 * and Codex's plan steps are just text plus a status, so the same signal lives
 * in the text: an open item whose subject starts with `[waiting on user]` is
 * parked on the user's answer, decision or review. The model rewrites its whole
 * list on every call, so the marker is as current as the list itself — when the
 * user replies, the next list the model writes drops it.
 */
export const WAITING_ON_USER_MARKER = '[waiting on user]';

const MARKER_PATTERN = /^\s*\[\s*waiting\s+on\s+(?:the\s+)?user\s*\]/i;

export function isWaitingOnUserSubject(subject: unknown): boolean {
  return typeof subject === 'string' && MARKER_PATTERN.test(subject);
}
