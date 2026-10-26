import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

import { sessionsDb } from '@/modules/database/index.js';
import type { AnyRecord, FetchHistoryOptions, FetchHistoryResult, NormalizedMessage } from '@/shared/index.js';
import { extractToolResultImages, sliceTailPage  } from '@/shared/index.js';

import { ClaudeSessionsProvider } from '../list/claude/claude-sessions.provider.js';

// Frozen pre-index reader used by differential tests to preserve history semantics.
const referenceProvider = new ClaudeSessionsProvider();
type ClaudeToolResult = {
  content: unknown;
  isError: boolean;
  images?: unknown;
  subagentTools?: unknown;
  toolUseResult?: unknown;
  interruptedByShutdown?: boolean;
};

type ClaudeHistoryResult =
  | AnyRecord[]
  | {
    messages?: AnyRecord[];
    total?: number;
    hasMore?: boolean;
  };

type ClaudeHistoryMessagesResult =
  | AnyRecord[]
  | {
    messages: AnyRecord[];
    total: number;
    hasMore: boolean;
    offset?: number;
    limit?: number | null;
  };

async function parseAgentTools(filePath: string): Promise<AnyRecord[]> {
  const tools: AnyRecord[] = [];

  try {
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) {
        continue;
      }

      try {
        const entry = JSON.parse(line) as AnyRecord;

        if (entry.message?.role === 'assistant' && Array.isArray(entry.message?.content)) {
          for (const part of entry.message.content as AnyRecord[]) {
            if (part.type === 'tool_use') {
              tools.push({
                toolId: part.id,
                toolName: part.name,
                toolInput: part.input,
                timestamp: entry.timestamp,
              });
            }
          }
        }

        if (entry.message?.role === 'user' && Array.isArray(entry.message?.content)) {
          for (const part of entry.message.content as AnyRecord[]) {
            if (part.type !== 'tool_result') {
              continue;
            }

            const tool = tools.find((candidate) => candidate.toolId === part.tool_use_id);
            if (!tool) {
              continue;
            }

            tool.toolResult = {
              content: typeof part.content === 'string'
                ? part.content
                : Array.isArray(part.content)
                  ? part.content
                    .map((contentPart: AnyRecord) => contentPart?.text || '')
                    .join('\n')
                  : JSON.stringify(part.content),
              isError: Boolean(part.is_error),
            };
          }
        }
      } catch {
        // Skip malformed lines that can happen during concurrent writes.
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Error parsing agent file ${filePath}:`, message);
  }

  return tools;
}

async function getSessionMessages(
  sessionId: string,
  providerSessionId: string,
  limit: number | null,
  offset: number,
): Promise<ClaudeHistoryMessagesResult> {
  try {
    // The DB row is keyed by the app-facing session id, while the JSONL rows
    // on disk carry the provider-native id — both ids are needed here.
    const jsonLPath = sessionsDb.getSessionById(sessionId)?.jsonl_path;

    if (!jsonLPath) {
      return { messages: [], total: 0, hasMore: false };
    }

    const projectDir = path.dirname(jsonLPath);

    // Claude stores Task/subagent transcripts under a per-session subfolder:
    //   <projectDir>/<providerSessionId>/subagents/agent-<id>.jsonl
    // The folder is named after the provider-native id (the transcript
    // basename), not the app-facing session id. Older transcripts kept them
    // flat in <projectDir>. Probe every known spelling so subagent tool output
    // nests inline under its parent tool call regardless of on-disk layout.
    // (These files carry the parent's sessionId, so they must never be indexed
    // as standalone sessions — see the synchronizer.)
    const sessionDirIds = [
      ...new Set([path.basename(jsonLPath, '.jsonl'), providerSessionId, sessionId].filter(Boolean)),
    ] as string[];
    const subagentDirs = [...sessionDirIds.map((id) => path.join(projectDir, id, 'subagents')), projectDir];
    const agentFilesByDir = new Map<string, Set<string>>();
    for (const dir of subagentDirs) {
      try {
        const entries = await fsp.readdir(dir);
        agentFilesByDir.set(
          dir,
          new Set(entries.filter((file) => file.endsWith('.jsonl') && file.startsWith('agent-'))),
        );
      } catch {
        // Directory may not exist (e.g. session spawned no subagents); skip it.
      }
    }

    const messages: AnyRecord[] = [];
    const agentToolsCache = new Map<string, AnyRecord[]>();

    const fileStream = fs.createReadStream(jsonLPath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) {
        continue;
      }

      try {
        const entry = JSON.parse(line) as AnyRecord;
        // Sidechain rows are a subagent's own conversation (its prompt + turns).
        // In the legacy flat layout they share the parent's sessionId and would
        // otherwise render in the main thread — the subagent prompt showing up
        // as a fake user message. They're surfaced via the subagent thread
        // viewer instead. (Newer layout keeps them in agent-*.jsonl already.)
        const isSidechain = entry.isSidechain === true || (entry.message as AnyRecord | undefined)?.isSidechain === true;
        if (entry.sessionId === providerSessionId && !isSidechain) {
          messages.push(entry);
        }
      } catch {
        // Skip malformed JSONL lines that can happen during concurrent writes.
      }
    }

    const agentIds = new Set<string>();
    for (const message of messages) {
      const agentId = message.toolUseResult?.agentId;
      if (agentId) {
        agentIds.add(String(agentId));
      }
    }

    for (const agentId of agentIds) {
      const agentFileName = `agent-${agentId}.jsonl`;

      let agentFilePath: string | null = null;
      for (const dir of subagentDirs) {
        if (agentFilesByDir.get(dir)?.has(agentFileName)) {
          agentFilePath = path.join(dir, agentFileName);
          break;
        }
      }

      if (!agentFilePath) {
        continue;
      }

      const tools = await parseAgentTools(agentFilePath);
      agentToolsCache.set(agentId, tools);
    }

    for (const message of messages) {
      const agentId = message.toolUseResult?.agentId;
      if (!agentId) {
        continue;
      }

      const agentTools = agentToolsCache.get(String(agentId));
      if (agentTools && agentTools.length > 0) {
        message.subagentTools = agentTools;
      }
    }

    const sortedMessages = messages.sort(
      (a, b) => new Date(a.timestamp || 0).getTime() - new Date(b.timestamp || 0).getTime(),
    );
    const total = sortedMessages.length;

    if (limit === null) {
      return sortedMessages;
    }

    const startIndex = Math.max(0, total - offset - limit);
    const endIndex = total - offset;
    const paginatedMessages = sortedMessages.slice(startIndex, endIndex);
    const hasMore = startIndex > 0;

    return {
      messages: paginatedMessages,
      total,
      hasMore,
      offset,
      limit,
    };
  } catch (error) {
    console.error(`Error reading messages for session ${sessionId}:`, error);
    return limit === null ? [] : { messages: [], total: 0, hasMore: false };
  }
}

// Consumed by provider differential tests as the pre-index reference implementation.
export async function referenceClaudeHistory(
    sessionId: string,
    options: FetchHistoryOptions = {},
  ): Promise<FetchHistoryResult> {
    const { limit = null, offset = 0 } = options;
    const providerSessionId = options.providerSessionId ?? sessionId;

    // A session can be indexed in the DB while its JSONL is gone from disk:
    // Claude Code prunes transcripts older than `cleanupPeriodDays` (30 by
    // default) and the watcher never deletes rows. Flag it so the UI can say
    // "history was auto-cleaned" instead of rendering a fresh empty chat.
    const indexedJsonlPath = sessionsDb.getSessionById(sessionId)?.jsonl_path;
    if (indexedJsonlPath && !fs.existsSync(indexedJsonlPath)) {
      return {
        messages: [],
        total: 0,
        hasMore: false,
        offset: 0,
        limit: null,
        transcriptMissing: true,
      };
    }

    let result: ClaudeHistoryResult;
    try {
      // Load full history first so `total` reflects frontend-normalized messages,
      // not raw JSONL records.
      result = await getSessionMessages(sessionId, providerSessionId, null, 0);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[ClaudeProvider] Failed to load session ${sessionId}:`, message);
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    }

    const rawMessages = Array.isArray(result) ? result : (result.messages || []);

    const toolResultMap = new Map<string, ClaudeToolResult>();
    for (const raw of rawMessages) {
      if (raw.message?.role === 'user' && Array.isArray(raw.message?.content)) {
        for (const part of raw.message.content) {
          if (part.type === 'tool_result' && part.tool_use_id) {
            toolResultMap.set(part.tool_use_id, {
              content: part.content,
              isError: Boolean(part.is_error),
              images: extractToolResultImages(part.content),
              subagentTools: raw.subagentTools,
              toolUseResult: raw.toolUseResult,
              interruptedByShutdown: Boolean(raw.interruptedByShutdown),
            });
          }
        }
      }
    }

    const normalized: NormalizedMessage[] = [];
    const seenMessageIds = new Set<string>();
    for (const raw of rawMessages) {
      for (const message of referenceProvider.normalizeMessage(raw, sessionId)) {
        // Repeated Claude 529 retries normalize to the same marker-derived id.
        // Keep the first bubble; the later provider attempts and their errors
        // remain in the raw transcript but do not spam the chat history.
        if (seenMessageIds.has(message.id)) continue;
        seenMessageIds.add(message.id);
        normalized.push(message);
      }
    }

    for (const msg of normalized) {
      if (msg.kind === 'tool_use' && msg.toolId && toolResultMap.has(msg.toolId)) {
        const toolResult = toolResultMap.get(msg.toolId);
        if (!toolResult) {
          continue;
        }

        msg.toolResult = {
          content: typeof toolResult.content === 'string'
            ? toolResult.content
            : JSON.stringify(toolResult.content),
          isError: toolResult.isError,
          ...(toolResult.images ? { images: toolResult.images } : {}),
          toolUseResult: toolResult.toolUseResult,
          interruptedByShutdown: toolResult.interruptedByShutdown,
        };
        msg.subagentTools = toolResult.subagentTools;
      }
    }

    let total = 0;
    for (const msg of normalized) {
      if (msg.kind !== 'tool_result') {
        total += 1;
      }
    }
    const normalizedOffset = Math.max(0, offset);
    const normalizedLimit = limit === null ? null : Math.max(0, limit);
    const { page, hasMore } = sliceTailPage(normalized, normalizedLimit, normalizedOffset);

    return {
      messages: page,
      total,
      hasMore,
      offset: normalizedOffset,
      limit: normalizedLimit,
    };
  }
