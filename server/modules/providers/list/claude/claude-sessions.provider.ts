import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

import type { IProviderSessions } from '@/shared/interfaces.js';
import type { AnyRecord, FetchHistoryOptions, FetchHistoryResult, NormalizedMessage, RewindResult } from '@/shared/types.js';
import { createNormalizedMessage, generateMessageId, readObjectRecord, sliceTailPage } from '@/shared/utils.js';
import { sessionsDb } from '@/modules/database/index.js';

const PROVIDER = 'claude';

type ClaudeToolResult = {
  content: unknown;
  isError: boolean;
  subagentTools?: unknown;
  toolUseResult?: unknown;
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

export type SubagentConversationEntry =
  | { type: 'user' | 'assistant' | 'thinking'; content: string; timestamp?: string }
  | {
    type: 'tool';
    toolId?: string;
    toolName: string;
    toolInput: unknown;
    toolResult: { content: string; isError: boolean } | null;
    timestamp?: string;
  };

function stringifyPartContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part: AnyRecord) => (typeof part?.text === 'string' ? part.text : '')).join('\n');
  }
  return content == null ? '' : JSON.stringify(content);
}

/**
 * Reads a subagent's full transcript (`agent-<agentId>.jsonl`) into an ordered,
 * render-ready conversation: the launching prompt, the subagent's text/thinking,
 * and its tool calls with results matched in. Powers the subagent thread viewer.
 */
export async function getSubagentConversation(
  sessionId: string,
  agentId: string,
): Promise<{ found: boolean; messages: SubagentConversationEntry[] }> {
  const jsonLPath = sessionsDb.getSessionById(sessionId)?.jsonl_path;
  if (!jsonLPath) {
    return { found: false, messages: [] };
  }

  const projectDir = path.dirname(jsonLPath);
  const agentFileName = `agent-${agentId}.jsonl`;
  const candidateDirs = [path.join(projectDir, sessionId, 'subagents'), projectDir];

  let agentFilePath: string | null = null;
  for (const dir of candidateDirs) {
    const candidate = path.join(dir, agentFileName);
    try {
      await fsp.access(candidate);
      agentFilePath = candidate;
      break;
    } catch {
      // not here — try the next layout
    }
  }
  if (!agentFilePath) {
    return { found: false, messages: [] };
  }

  const messages: SubagentConversationEntry[] = [];
  const toolsById = new Map<string, Extract<SubagentConversationEntry, { type: 'tool' }>>();

  try {
    const rl = readline.createInterface({
      input: fs.createReadStream(agentFilePath),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) continue;
      let entry: AnyRecord;
      try {
        entry = JSON.parse(line) as AnyRecord;
      } catch {
        continue;
      }

      const message = entry.message as AnyRecord | undefined;
      const role = message?.role;
      const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : undefined;

      if (role === 'assistant') {
        const content = message?.content;
        if (typeof content === 'string') {
          if (content.trim()) messages.push({ type: 'assistant', content, timestamp });
        } else if (Array.isArray(content)) {
          for (const part of content as AnyRecord[]) {
            if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
              messages.push({ type: 'assistant', content: part.text, timestamp });
            } else if (part.type === 'thinking' && typeof part.thinking === 'string' && part.thinking.trim()) {
              messages.push({ type: 'thinking', content: part.thinking, timestamp });
            } else if (part.type === 'tool_use') {
              const tool: Extract<SubagentConversationEntry, { type: 'tool' }> = {
                type: 'tool',
                toolId: typeof part.id === 'string' ? part.id : undefined,
                toolName: typeof part.name === 'string' ? part.name : 'tool',
                toolInput: part.input,
                toolResult: null,
                timestamp,
              };
              messages.push(tool);
              if (tool.toolId) toolsById.set(tool.toolId, tool);
            }
          }
        }
      } else if (role === 'user') {
        const content = message?.content;
        if (typeof content === 'string') {
          if (content.trim()) messages.push({ type: 'user', content, timestamp });
        } else if (Array.isArray(content)) {
          for (const part of content as AnyRecord[]) {
            if (part.type === 'tool_result') {
              const tool = typeof part.tool_use_id === 'string' ? toolsById.get(part.tool_use_id) : undefined;
              if (tool) {
                tool.toolResult = {
                  content: stringifyPartContent(part.content),
                  isError: Boolean(part.is_error),
                };
              }
            } else if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
              messages.push({ type: 'user', content: part.text, timestamp });
            }
          }
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Error reading subagent conversation ${agentFilePath}:`, message);
    return { found: false, messages: [] };
  }

  return { found: true, messages };
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
    //   <projectDir>/<sessionId>/subagents/agent-<id>.jsonl
    // Older transcripts kept them flat in <projectDir>. Probe both locations so
    // subagent tool output nests inline under its parent tool call regardless of
    // on-disk layout. (These files carry the parent's sessionId, so they must
    // never be indexed as standalone sessions — see the synchronizer.)
    const subagentDirs = [path.join(projectDir, sessionId, 'subagents'), projectDir];
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

/**
 * Claude writes a mix of truly internal transcript rows and "UI-hidden" local
 * command artifacts into the same JSONL stream.
 *
 * Important distinction:
 * - system reminders / caveats / interruption banners should stay hidden
 * - local command payloads (`<command-name>...`) and stdout wrappers
 *   (`<local-command-stdout>...`) should be remapped into normal chat messages
 *   instead of being discarded as internal content
 */
const INTERNAL_CONTENT_PREFIXES = [
  '<system-reminder>',
  'Caveat:',
  '[Request interrupted',
] as const;

function isInternalContent(content: string): boolean {
  return INTERNAL_CONTENT_PREFIXES.some((prefix) => content.startsWith(prefix));
}

/**
 * Claude wraps local slash-command metadata in lightweight XML-like tags inside
 * a plain string payload. We intentionally parse only the small tag surface we
 * care about instead of introducing a generic XML parser for untrusted history.
 */
function extractTaggedContent(content: string, tagName: string): string | null {
  const escapedTagName = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<${escapedTagName}>([\\s\\S]*?)<\\/${escapedTagName}>`).exec(content);
  return match ? match[1] : null;
}

type ClaudeLocalCommandPayload = {
  commandName: string;
  commandMessage: string;
  commandArgs: string;
};

/**
 * Converts Claude's hidden local command wrapper into structured metadata.
 *
 * The three tags often coexist in one string payload. Returning `null` lets the
 * normal text path continue untouched for unrelated messages.
 */
function parseLocalCommandPayload(content: string): ClaudeLocalCommandPayload | null {
  const commandName = extractTaggedContent(content, 'command-name');
  const commandMessage = extractTaggedContent(content, 'command-message');
  const commandArgs = extractTaggedContent(content, 'command-args');

  if (commandName === null && commandMessage === null && commandArgs === null) {
    return null;
  }

  return {
    commandName: commandName ?? '',
    commandMessage: commandMessage ?? '',
    commandArgs: commandArgs ?? '',
  };
}

/**
 * Produces the short user-visible command string that should appear in chat.
 *
 * We prefer the slash-prefixed command name because that most closely matches
 * what the user actually typed, and only fall back to the message body when the
 * command name is unavailable in older transcript variants.
 */
function buildLocalCommandDisplayText(payload: ClaudeLocalCommandPayload): string {
  const commandName = payload.commandName.trim();
  const commandMessage = payload.commandMessage.trim();
  const commandArgs = payload.commandArgs.trim();
  const baseCommand = commandName || commandMessage;

  if (!baseCommand) {
    return '';
  }

  return commandArgs ? `${baseCommand} ${commandArgs}` : baseCommand;
}

/**
 * Claude local-command stdout may contain ANSI styling codes because it was
 * captured from the terminal. The web chat should receive readable plain text.
 */
function stripAnsiFormatting(text: string): string {
  return text.replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, '');
}

export class ClaudeSessionsProvider implements IProviderSessions {
  /**
   * Normalizes one Claude JSONL entry or live SDK stream event into the shared
   * message shape consumed by REST and WebSocket clients.
   */
  normalizeMessage(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    const raw = readObjectRecord(rawMessage);
    if (!raw) {
      return [];
    }

    // Claude CLI surfaces API failures as synthetic assistant messages
    // (`isApiErrorMessage: true`, `message.model: "<synthetic>"`). The default
    // assistant-text branch would render them as a normal model reply, which
    // hides the failure and — for "Prompt is too long" — leaves the session
    // wedged with no signal to /compact or branch out.
    if (raw.isApiErrorMessage === true) {
      const rawContent = raw.message?.content;
      const rawText = Array.isArray(rawContent)
        ? rawContent
            .filter((part: AnyRecord) => part?.type === 'text' && typeof part.text === 'string')
            .map((part: AnyRecord) => part.text)
            .join('\n')
        : (typeof rawContent === 'string' ? rawContent : '');
      const errorText = rawText.trim() || 'Claude API error';

      const content = /prompt is too long/i.test(errorText)
        ? [
            '**Context too large**: this session\'s history exceeds the model\'s input limit.',
            '',
            'Resending the same prompt will keep hitting this error. Choose one:',
            '- Run `/compact` to summarize the conversation in place.',
            '- Start a fresh session in the same project to continue work.',
            '',
            `_(original error: ${errorText})_`,
          ].join('\n')
        : errorText;

      return [createNormalizedMessage({
        id: raw.uuid || generateMessageId('claude'),
        sessionId,
        timestamp: raw.timestamp || new Date().toISOString(),
        provider: PROVIDER,
        kind: 'error',
        content,
      })];
    }

    if (raw.type === 'content_block_delta' && raw.delta?.text) {
      return [createNormalizedMessage({ kind: 'stream_delta', content: raw.delta.text, sessionId, provider: PROVIDER })];
    }
    if (raw.type === 'content_block_stop') {
      return [createNormalizedMessage({ kind: 'stream_end', sessionId, provider: PROVIDER })];
    }

    const messages: NormalizedMessage[] = [];
    const ts = raw.timestamp || new Date().toISOString();
    const baseId = raw.uuid || generateMessageId('claude');

    if (raw.message?.role === 'user' && raw.message?.content && raw.isMeta !== true) {
      if (Array.isArray(raw.message.content)) {
        // Image attachments sent through the SDK are persisted as base64
        // `image` blocks next to the prompt text. Collect them so the UI can
        // render them on the user bubble.
        const imageAttachments: Array<{ data: string }> = [];
        for (const part of raw.message.content) {
          if (part?.type === 'image' && part.source?.type === 'base64' && typeof part.source.data === 'string') {
            const mediaType = typeof part.source.media_type === 'string' ? part.source.media_type : 'image/png';
            imageAttachments.push({ data: `data:${mediaType};base64,${part.source.data}` });
          }
        }
        let imagesAttached = false;

        for (let partIndex = 0; partIndex < raw.message.content.length; partIndex++) {
          const part = raw.message.content[partIndex];
          if (part.type === 'tool_result') {
            messages.push(createNormalizedMessage({
              id: `${baseId}_tr_${part.tool_use_id}`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'tool_result',
              toolId: part.tool_use_id,
              content: typeof part.content === 'string' ? part.content : JSON.stringify(part.content),
              isError: Boolean(part.is_error),
              subagentTools: raw.subagentTools,
              // JSONL transcript rows spell this `toolUseResult`; live SDK
              // stream events spell it `tool_use_result`. Without the fallback
              // the live path never learns e.g. a subagent's agentId, so the
              // transcript viewer can't resolve running agents.
              toolUseResult: raw.toolUseResult ?? raw.tool_use_result,
            }));
          } else if (part.type === 'text') {
            const text = part.text || '';
            if (text && !isInternalContent(text)) {
              messages.push(createNormalizedMessage({
                id: `${baseId}_text_${partIndex}`,
                uuid: raw.uuid,
                sessionId,
                timestamp: ts,
                provider: PROVIDER,
                kind: 'text',
                role: 'user',
                content: text,
                images: !imagesAttached && imageAttachments.length > 0 ? imageAttachments : undefined,
              }));
              imagesAttached = true;
            }
          }
        }

        if (messages.length === 0) {
          const textParts = raw.message.content
            .filter((part: AnyRecord) => part.type === 'text')
            .map((part: AnyRecord) => part.text)
            .filter(Boolean)
            .join('\n');
          if (textParts && !isInternalContent(textParts)) {
            messages.push(createNormalizedMessage({
              id: `${baseId}_text`,
              uuid: raw.uuid,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'text',
              role: 'user',
              content: textParts,
              images: imageAttachments.length > 0 ? imageAttachments : undefined,
            }));
            imagesAttached = true;
          }
        }

        // Image-only turns still deserve a user bubble even without text.
        if (!imagesAttached && imageAttachments.length > 0) {
          messages.push(createNormalizedMessage({
            id: `${baseId}_images`,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'text',
            role: 'user',
            content: '',
            images: imageAttachments,
          }));
        }
      } else if (typeof raw.message.content === 'string') {
        const text = raw.message.content;

        /**
         * Claude stores compact summaries as synthetic "user" rows so the CLI
         * can resume the next session turn with the summary in-context.
         *
         * For the web UI this is much more useful as assistant-authored summary
         * text; otherwise it is both filtered by the generic internal-prefix
         * check and visually mislabeled as a user message.
         */
        if (raw.isCompactSummary === true && text.trim()) {
          messages.push(createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'text',
            role: 'assistant',
            content: text,
            isCompactSummary: true,
          }));
          return messages;
        }

        /**
         * Local slash commands are serialized as tagged text even though they
         * are semantically a user action. Expose the parsed fields to the
         * frontend and emit a plain user-visible command string so the command
         * no longer disappears from history.
         */
        const localCommandPayload = parseLocalCommandPayload(text);
        if (localCommandPayload) {
          const displayText = buildLocalCommandDisplayText(localCommandPayload);
          if (displayText) {
            messages.push(createNormalizedMessage({
              id: baseId,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'text',
              role: 'user',
              content: displayText,
              commandName: localCommandPayload.commandName,
              commandMessage: localCommandPayload.commandMessage,
              commandArgs: localCommandPayload.commandArgs,
              isLocalCommand: true,
            }));
          }
          return messages;
        }

        /**
         * Local command stdout is also written as a "user" row in Claude's
         * transcript, but it is terminal output produced in response to the
         * command. Re-label it as assistant text so the chat transcript matches
         * the actual conversational flow seen by the user.
         */
        const localCommandStdout = extractTaggedContent(text, 'local-command-stdout');
        if (localCommandStdout !== null) {
          const stdoutText = stripAnsiFormatting(localCommandStdout).trim();
          if (stdoutText) {
            messages.push(createNormalizedMessage({
              id: baseId,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'text',
              role: 'assistant',
              content: stdoutText,
              isLocalCommandStdout: true,
            }));
          }
          return messages;
        }

        if (text && !isInternalContent(text)) {
          messages.push(createNormalizedMessage({
            id: baseId,
            uuid: raw.uuid,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'text',
            role: 'user',
            content: text,
          }));
        }
      }
      return messages;
    }

    if (raw.type === 'thinking' && raw.message?.content) {
      messages.push(createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'thinking',
        content: raw.message.content,
      }));
      return messages;
    }

    if (raw.type === 'tool_use' && raw.toolName) {
      messages.push(createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'tool_use',
        toolName: raw.toolName,
        toolInput: raw.toolInput,
        toolId: raw.toolCallId || baseId,
      }));
      return messages;
    }

    if (raw.type === 'tool_result') {
      messages.push(createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'tool_result',
        toolId: raw.toolCallId || '',
        content: raw.output || '',
        isError: false,
      }));
      return messages;
    }

    if (raw.message?.role === 'assistant' && raw.message?.content) {
      if (Array.isArray(raw.message.content)) {
        let partIndex = 0;
        for (const part of raw.message.content) {
          if (part.type === 'text' && part.text) {
            messages.push(createNormalizedMessage({
              id: `${baseId}_${partIndex}`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'text',
              role: 'assistant',
              content: part.text,
            }));
          } else if (part.type === 'tool_use') {
            messages.push(createNormalizedMessage({
              id: `${baseId}_${partIndex}`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'tool_use',
              toolName: part.name,
              toolInput: part.input,
              toolId: part.id,
            }));
          } else if (part.type === 'thinking' && part.thinking) {
            messages.push(createNormalizedMessage({
              id: `${baseId}_${partIndex}`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'thinking',
              content: part.thinking,
            }));
          }
          partIndex++;
        }
      } else if (typeof raw.message.content === 'string') {
        messages.push(createNormalizedMessage({
          id: baseId,
          sessionId,
          timestamp: ts,
          provider: PROVIDER,
          kind: 'text',
          role: 'assistant',
          content: raw.message.content,
        }));
      }
      return messages;
    }

    return messages;
  }

  /**
   * Loads Claude JSONL history for a project/session and returns normalized
   * messages, preserving the existing pagination behavior from projects.js.
   */
  async fetchHistory(
    sessionId: string,
    options: FetchHistoryOptions = {},
  ): Promise<FetchHistoryResult> {
    const { limit = null, offset = 0 } = options;
    const providerSessionId = options.providerSessionId ?? sessionId;

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
              subagentTools: raw.subagentTools,
              toolUseResult: raw.toolUseResult,
            });
          }
        }
      }
    }

    const normalized: NormalizedMessage[] = [];
    for (const raw of rawMessages) {
      normalized.push(...this.normalizeMessage(raw, sessionId));
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
          toolUseResult: toolResult.toolUseResult,
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

  /**
   * Rewinds the session's JSONL transcript by truncating every line from the
   * record whose `uuid === messageUuid` onward (inclusive). The original file is
   * backed up alongside it first. Resuming the same session id then continues the
   * conversation in-place from the kept prefix.
   *
   * If the anchor is the first user turn (nothing resumable precedes it) the file
   * is left untouched and `startFresh` is returned so the caller can begin a new
   * session instead.
   */
  async rewindHistory(sessionId: string, messageUuid: string): Promise<RewindResult> {
    const jsonLPath = sessionsDb.getSessionById(sessionId)?.jsonl_path;
    if (!jsonLPath) {
      return { ok: false, startFresh: false, removed: 0 };
    }

    let raw: string;
    try {
      raw = await fsp.readFile(jsonLPath, 'utf8');
    } catch {
      return { ok: false, startFresh: false, removed: 0 };
    }

    const lines = raw.split('\n');
    let cutIndex = -1;
    let priorUserTurns = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) {
        continue;
      }
      let entry: AnyRecord;
      try {
        entry = JSON.parse(line) as AnyRecord;
      } catch {
        continue;
      }
      if (entry.sessionId !== sessionId) {
        continue;
      }
      if (entry.uuid === messageUuid) {
        cutIndex = i;
        break;
      }
      if (entry.message?.role === 'user' && entry.isMeta !== true && entry.type !== 'tool_result') {
        priorUserTurns += 1;
      }
    }

    if (cutIndex === -1) {
      return { ok: false, startFresh: false, removed: 0 };
    }

    // Nothing resumable precedes the edited message — let the caller start fresh
    // and leave the original transcript intact as pre-edit history.
    if (priorUserTurns === 0) {
      const removed = lines.slice(cutIndex).filter((line) => line.trim()).length;
      return { ok: true, startFresh: true, removed };
    }

    const kept = lines.slice(0, cutIndex);
    const removed = lines.slice(cutIndex).filter((line) => line.trim()).length;

    // Back up the full transcript before truncating so a rewind is recoverable.
    try {
      await fsp.copyFile(jsonLPath, `${jsonLPath}.rewind-${Date.now()}.bak`);
    } catch (error) {
      console.warn(`[ClaudeProvider] Failed to back up transcript before rewind for ${sessionId}:`, error);
    }

    const body = kept.join('\n').replace(/\n+$/, '');
    await fsp.writeFile(jsonLPath, body.length > 0 ? `${body}\n` : '');

    return { ok: true, startFresh: false, removed };
  }
}
