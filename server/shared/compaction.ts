/**
 * Compaction, normalized across the CLIs.
 *
 * Every runtime compacts the same way — swap the transcript for a summary and
 * carry on — but each records it differently, and none of them records it as
 * something a transcript viewer would want to show verbatim:
 *
 * - Claude writes a `compact_boundary` system row followed by a synthetic
 *   *user* row flagged `isCompactSummary`, whose text is the whole summary.
 * - OpenCode flags the assistant message that *is* the summary (`summary: true`).
 * - Codex writes a `compacted` rollout entry; recent versions encrypt the
 *   summary, so only the fact of the compaction survives.
 * - Cursor rewrites its stored blobs in place and records nothing at all.
 *
 * Left alone, the Claude and OpenCode shapes render as a wall of summary text —
 * attributed to the user, no less, since that is the role the runtime replays it
 * under. Providers funnel all of them into a single `compact_boundary` message
 * carrying the summary in `compaction.summary`, so the UI has exactly one thing
 * to draw and can keep the text folded away until asked for.
 */

import type { CompactionInfo, LLMProvider, NormalizedMessage } from './types.js';
import { createNormalizedMessage, generateMessageId } from './utils.js';

/**
 * Preamble the runtimes wrap a summary in before replaying it as a prompt.
 *
 * This is the fallback for rows that carry no structural flag — an older
 * transcript written before the runtime started flagging them, or a runtime
 * (Cursor) that never flags them at all. It is matched against the *start* of a
 * user turn only, which no ordinary prompt begins with.
 */
const COMPACT_SUMMARY_PREAMBLE = 'this session is being continued from a previous conversation';

/**
 * True when a user turn is really a replayed compaction summary.
 *
 * Deliberately narrow: a false positive folds a real prompt away behind a
 * disclosure, so only the verbatim runtime preamble counts.
 */
export function looksLikeCompactSummary(text: unknown): boolean {
  if (typeof text !== 'string') {
    return false;
  }
  return text.trimStart().slice(0, COMPACT_SUMMARY_PREAMBLE.length).toLowerCase() === COMPACT_SUMMARY_PREAMBLE;
}

/**
 * Builds the one message a compaction turns into.
 *
 * `summary` is optional on purpose — Codex reports that a compaction happened
 * without handing over the text, and a marker with no expandable body is still
 * far better than the silent gap the transcript would otherwise show.
 */
export function createCompactBoundaryMessage(options: {
  id?: string;
  sessionId: string | null;
  timestamp?: string;
  provider: LLMProvider;
  trigger?: 'manual' | 'auto';
  summary?: string;
  preTokens?: number;
  postTokens?: number;
  durationMs?: number;
}): NormalizedMessage {
  const compaction: CompactionInfo = { trigger: options.trigger === 'auto' ? 'auto' : 'manual' };
  if (typeof options.preTokens === 'number' && Number.isFinite(options.preTokens)) {
    compaction.preTokens = options.preTokens;
  }
  if (typeof options.postTokens === 'number' && Number.isFinite(options.postTokens)) {
    compaction.postTokens = options.postTokens;
  }
  if (typeof options.durationMs === 'number' && Number.isFinite(options.durationMs)) {
    compaction.durationMs = options.durationMs;
  }
  if (typeof options.summary === 'string' && options.summary.trim()) {
    compaction.summary = options.summary.trim();
  }

  return createNormalizedMessage({
    id: options.id || generateMessageId(options.provider),
    sessionId: options.sessionId,
    timestamp: options.timestamp || new Date().toISOString(),
    provider: options.provider,
    kind: 'compact_boundary',
    // Kept for the conversation-search indexer, which already keys compact
    // summaries off this flag.
    isCompactSummary: Boolean(compaction.summary),
    compaction,
  });
}
