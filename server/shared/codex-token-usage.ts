import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AnyRecord } from '@/shared/types.js';

export type CodexTokenBudget = {
  /** Tokens currently occupying the model context. */
  used: number;
  /** The model's effective context window, or 0 when occupancy is unknown. */
  total: number;
  /** Cumulative spend across the whole session. */
  sessionTotalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cumulativeInputTokens: number;
  cumulativeOutputTokens: number;
  contextInputTokens: number;
  contextOutputTokens: number;
  breakdown: {
    input: number;
    output: number;
  };
};

const sessionPathCache = new Map<string, string>();

const readNumber = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};

const readTokenTotal = (usage: AnyRecord | null): number => {
  if (!usage) return 0;
  return readNumber(usage.total_tokens)
    || readNumber(usage.input_tokens) + readNumber(usage.output_tokens);
};

/**
 * Codex reports two very different numbers in each token_count event:
 *
 * - total_token_usage is cumulative billing/spend across every model call.
 * - last_token_usage is the latest request and therefore the current context.
 *
 * Only the latter can be divided by model_context_window. Long tool-using
 * sessions routinely spend several times their context window in aggregate.
 */
export function buildCodexTokenBudget(info: unknown): CodexTokenBudget | null {
  if (!info || typeof info !== 'object') return null;

  const record = info as AnyRecord;
  const cumulative = record.total_token_usage && typeof record.total_token_usage === 'object'
    ? record.total_token_usage as AnyRecord
    : null;
  const current = record.last_token_usage && typeof record.last_token_usage === 'object'
    ? record.last_token_usage as AnyRecord
    : null;

  const sessionTotalTokens = readTokenTotal(cumulative);
  const currentTokens = readTokenTotal(current);
  if (sessionTotalTokens <= 0 && currentTokens <= 0) return null;

  const cumulativeInputTokens = readNumber(cumulative?.input_tokens);
  const cumulativeOutputTokens = readNumber(cumulative?.output_tokens);
  const contextInputTokens = readNumber(current?.input_tokens);
  const contextOutputTokens = readNumber(current?.output_tokens);
  const contextWindow = readNumber(record.model_context_window);
  const hasContextReading = currentTokens > 0 && contextWindow > 0;

  return {
    // Older rollouts do not have last_token_usage. Keep their cumulative count
    // visible, but suppress a percentage rather than inventing an occupancy.
    used: hasContextReading ? currentTokens : sessionTotalTokens || currentTokens,
    total: hasContextReading ? contextWindow : 0,
    sessionTotalTokens: sessionTotalTokens || currentTokens,
    inputTokens: cumulativeInputTokens || contextInputTokens,
    outputTokens: cumulativeOutputTokens || contextOutputTokens,
    cumulativeInputTokens,
    cumulativeOutputTokens,
    contextInputTokens,
    contextOutputTokens,
    breakdown: {
      input: cumulativeInputTokens || contextInputTokens,
      output: cumulativeOutputTokens || contextOutputTokens,
    },
  };
}

async function findSessionFile(dir: string, sessionId: string): Promise<string | null> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = await findSessionFile(fullPath, sessionId);
      if (found) return found;
    } else if (entry.name.endsWith('.jsonl') && entry.name.includes(sessionId)) {
      return fullPath;
    }
  }

  return null;
}

export async function readLatestCodexTokenBudget(
  sessionId: string | null | undefined,
  knownPath?: string | null,
): Promise<CodexTokenBudget | null> {
  if (!sessionId) return null;

  let sessionPath = knownPath || sessionPathCache.get(sessionId) || null;
  if (!sessionPath) {
    sessionPath = await findSessionFile(path.join(os.homedir(), '.codex', 'sessions'), sessionId);
    if (!sessionPath) return null;
    sessionPathCache.set(sessionId, sessionPath);
  }

  let contents: string;
  try {
    contents = await fs.readFile(sessionPath, 'utf8');
  } catch {
    sessionPathCache.delete(sessionId);
    return null;
  }

  const lines = contents.trim().split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const entry = JSON.parse(lines[index]) as AnyRecord;
      if (entry.type === 'event_msg' && entry.payload?.type === 'token_count' && entry.payload.info) {
        return buildCodexTokenBudget(entry.payload.info);
      }
    } catch {
      // A rollout can be read while Codex is appending its final line.
    }
  }

  return null;
}
