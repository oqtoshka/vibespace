import { sessionsDb } from '@/modules/database/index.js';
import type { AnyRecord, FetchHistoryOptions, FetchHistoryResult, IProviderSessions, NormalizedMessage } from '@/shared/index.js';
import {
  buildCodexTokenBudget, createCompactBoundaryMessage, createNormalizedMessage,
  extractToolResultImages, generateMessageId, looksLikeCompactSummary,
  parseFilesInputTag, readObjectRecord, sliceTailPage, toImageAttachments,
} from '@/shared/index.js';

import { readCodexRevertedHistory } from '../../services/codex-reverted-history.service.js';

import { readCodexRollout } from './codex-rollout-reader.provider.js';

const PROVIDER = 'codex';

type CodexHistoryResult =
  | AnyRecord[]
  | {
      messages?: AnyRecord[];
      total?: number;
      hasMore?: boolean;
      offset?: number;
      limit?: number | null;
      tokenUsage?: unknown;
      /** Set for rollout reads: lets fetchHistory reuse its normalized view per generation. */
      view?: { parser: CodexRolloutParser; generation: number };
    };

/** fetchHistory's normalized list for one parser generation and app session id. */
type NormalizedView = { generation: number; sessionId: string; messages: NormalizedMessage[]; total: number };

/** A legacy `user_message` the user typed; the Codex session synchronizer titles sessions from it too. */
export function isVisibleCodexUserMessage(payload: AnyRecord | null | undefined): boolean {
  if (!payload || payload.type !== 'user_message') {
    return false;
  }

  if (payload.kind && payload.kind !== 'plain') {
    return false;
  }

  return typeof payload.message === 'string' && payload.message.trim().length > 0;
}

/**
 * Pulls the readable summary out of a Codex `compacted` entry, if there is one.
 *
 * Codex >=0.144 replaces the transcript with an opaque `compaction` item whose
 * body is encrypted, so most compactions have no text to show and the marker
 * stands alone. Older rollouts left the summary in `payload.message`, or as the
 * replayed bridge turn at the tail of `replacement_history` — both are worth
 * recovering for sessions already on disk.
 *
 * Exported for tests.
 */
export function extractCodexCompactionSummary(payload: AnyRecord | null | undefined): string | undefined {
  if (!payload) {
    return undefined;
  }

  if (typeof payload.message === 'string' && payload.message.trim()) {
    return payload.message;
  }

  const history = Array.isArray(payload.replacement_history) ? payload.replacement_history : [];
  for (let index = history.length - 1; index >= 0; index--) {
    const item = readObjectRecord(history[index]);
    const text = Array.isArray(item?.content)
      ? item.content
          .map((part: AnyRecord) => (typeof part?.text === 'string' ? part.text : ''))
          .filter(Boolean)
          .join('\n')
      : '';
    if (looksLikeCompactSummary(text)) {
      return text;
    }
  }

  return undefined;
}

/**
 * Reads the image attachments Codex records on user events. Legacy
 * `user_message` payloads use `local_images` / `images`; current completed
 * `UserMessage` items keep `local_image` / `input_image` entries inside
 * `content`. Data URLs pass through as inline attachments so the UI can
 * preview them without a file lookup.
 *
 * Exported for tests.
 */
export function extractCodexUserImages(
  payload: AnyRecord | null | undefined,
): Array<{ path?: string; data?: string }> | undefined {
  if (!payload) {
    return undefined;
  }

  const candidates = [
    ...(Array.isArray(payload.local_images) ? payload.local_images : []),
    ...(Array.isArray(payload.images) ? payload.images : []),
    ...(Array.isArray(payload.content) ? payload.content.flatMap((item: unknown) => {
      const record = readObjectRecord(item);
      if (record?.type === 'local_image' && typeof record.path === 'string') {
        return [record.path];
      }
      if (record?.type === 'input_image' && typeof record.image_url === 'string') {
        return [record.image_url];
      }
      return [];
    }) : []),
  ];

  const attachments: Array<{ path?: string; data?: string }> = [];
  for (const entry of candidates) {
    if (typeof entry !== 'string' || !entry.trim()) {
      continue;
    }
    if (entry.startsWith('data:')) {
      attachments.push({ data: entry });
    } else {
      attachments.push(...toImageAttachments([entry]));
    }
  }

  return attachments.length > 0 ? attachments : undefined;
}

/** Joins a Codex message's text parts; the Codex session synchronizer reads prompts with it too. */
export function extractCodexTextContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return typeof content === 'string' ? content : '';
  }

  return content
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return '';
      }

      const record = item as AnyRecord;
      if (
        (record.type === 'input_text' || record.type === 'output_text' || record.type === 'text')
        && typeof record.text === 'string'
      ) {
        return record.text;
      }

      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function extractCodexToolOutput(output: unknown): string {
  if (typeof output === 'string') {
    return output;
  }

  if (!Array.isArray(output)) {
    return output == null ? '' : JSON.stringify(output);
  }

  return output
    .map((item) => {
      const record = readObjectRecord(item);
      return typeof record?.text === 'string' ? record.text : '';
    })
    .filter(Boolean)
    .join('');
}

function readRunningExecOutput(output: string): { cellId: string; content: string } | null {
  const runningCell = /Script running with cell ID\s+(\S+)/i.exec(output);
  if (!runningCell) {
    return null;
  }

  const outputMarker = /\r?\nOutput:\r?\n/i.exec(output);
  return {
    cellId: runningCell[1],
    content: outputMarker ? output.slice((outputMarker.index || 0) + outputMarker[0].length) : '',
  };
}

function decodeJavaScriptStringLiteral(literal: string): string {
  if (literal.startsWith('"')) {
    try {
      return JSON.parse(literal) as string;
    } catch {
      return literal.slice(1, -1);
    }
  }

  return literal
    .slice(1, -1)
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\([\\'`])/g, '$1');
}

function extractNestedCodexCommands(source: string): string[] {
  const commands: string[] = [];
  const commandPattern = /(?:["']command["']|\bcommand)\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/gs;
  for (const match of source.matchAll(commandPattern)) {
    commands.push(decodeJavaScriptStringLiteral(match[1]));
  }

  if (commands.length === 0) {
    const arrayPattern = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\[([\s\S]*?)\]\s*;/g;
    const stringPattern = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/g;

    for (const arrayMatch of source.matchAll(arrayPattern)) {
      const arrayName = arrayMatch[1];
      if (!new RegExp(`\\b${arrayName}\\.map\\s*\\(`).test(source)) {
        continue;
      }
      for (const stringMatch of arrayMatch[2].matchAll(stringPattern)) {
        commands.push(decodeJavaScriptStringLiteral(stringMatch[1]));
      }
    }
  }

  return commands;
}

/**
 * Newer Codex rollouts persist the orchestration wrapper (`exec`) instead of
 * the nested tool name. Recover the useful UI-level operation so history does
 * not degrade into rows labelled only "exec / Parameters".
 */
function translateCodexExecInput(input: unknown): { toolName: string; toolInput: string } | null {
  const source = typeof input === 'string' ? input : String(input || '');
  if (/\btools\.(?:shell_command|exec_command)\s*\(/.test(source)) {
    const commands = extractNestedCodexCommands(source);
    if (commands.length > 0) {
      return {
        toolName: 'Bash',
        toolInput: JSON.stringify({ command: commands.join('\n') }),
      };
    }
  }

  return null;
}

function humanizeCodexToolName(toolName: string): string {
  return toolName
    .replace(/__/g, ' ')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

type CodexSubagentRecord = {
  toolCallId: string;
  message: AnyRecord;
  agentPath?: string;
  isComplete: boolean;
};

function parseCodexSubagentMessage(payload: AnyRecord): {
  author: string;
  messageType: string;
  result: string;
} | null {
  const text = extractCodexTextContent(payload.content);
  const header = /Message Type:\s*([^\r\n]+)[\s\S]*?Sender:\s*([^\r\n]+)[\s\S]*?Payload:\s*\r?\n([\s\S]*)/i.exec(text);
  const author = readNonEmptyString(payload.author) || header?.[2]?.trim();
  if (!author) {
    return null;
  }

  return {
    author,
    messageType: header?.[1]?.trim().toUpperCase() || 'MESSAGE',
    result: header?.[3]?.trim() || '',
  };
}

const CODEX_COLLABORATION_CONTROL_TOOLS = new Set([
  'followup_task',
  'interrupt_agent',
  'list_agents',
  'send_message',
  'wait_agent',
]);

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * The stateful rollout-to-history parser. It consumes rollout lines in file
 * order; the incremental reader keeps one instance per file alive and feeds
 * it only appended lines, so its state must depend on nothing but the lines
 * seen so far.
 */
class CodexRolloutParser {
  messages: AnyRecord[] = [];
  tokenUsage: AnyRecord | null = null;
  private currentTurn: string | undefined;
  private userSeen = false;
  private readonly turnStarts: Array<{ id: string; offset: number; tokenUsage: AnyRecord | null }> = [];
  private readonly ignoredToolCallIds = new Set<string>();
  private readonly execToolCallIds = new Set<string>();
  private readonly execCallByCellId = new Map<string, string>();
  private readonly waitCallToExecCall = new Map<string, string>();
  private readonly pendingExecOutput = new Map<string, string>();
  private readonly completedExecCalls = new Set<string>();
  private readonly subagentsByCallId = new Map<string, CodexSubagentRecord>();
  private readonly subagentsByPath = new Map<string, CodexSubagentRecord>();
  private sorted: { generation: number; messages: AnyRecord[] } | null = null;
  /** Owned by fetchHistory; lives and dies with this parser in the reader cache. */
  normalizedView: NormalizedView | null = null;

  /** Returns true when the line added history entries (the cache budget counts those bytes). */
  consume(line: string): boolean {
    if (!line.trim()) {
      return false;
    }
    const before = this.messages.length;
    try {
      this.consumeEntry(JSON.parse(line) as AnyRecord);
    } catch {
      // Skip malformed lines.
    }
    return this.messages.length > before;
  }

  /**
   * History entries in timestamp order (a stable sort of parse order), cached
   * per reader generation so unchanged files are not re-sorted per page.
   */
  sortedMessages(generation: number): AnyRecord[] {
    if (this.sorted?.generation !== generation) {
      const keyed = this.messages.map((message, index) => ({
        message, index, time: new Date(message.timestamp || 0).getTime(),
      }));
      // Same comparator as before; NaN compares as "equal", and the index
      // tie-break reproduces Array#sort stability explicitly.
      keyed.sort((a, b) => (a.time - b.time) || a.index - b.index);
      this.sorted = { generation, messages: keyed.map(item => item.message) };
    }
    return this.sorted.messages;
  }

  private consumeEntry(entry: AnyRecord): void {
    if (entry.type === 'event_msg' && entry.payload?.type === 'thread_rolled_back') {
      const count = entry.payload.num_turns;
      if (Number.isInteger(count) && count > 0 && this.turnStarts.length) {
        const index = Math.max(0, this.turnStarts.length - count);
        const boundary = this.turnStarts[index];
        this.messages.splice(boundary.offset);
        this.tokenUsage = boundary.tokenUsage;
        this.turnStarts.splice(index);
        this.currentTurn = undefined; this.userSeen = false;
        this.ignoredToolCallIds.clear(); this.execToolCallIds.clear(); this.execCallByCellId.clear();
        this.waitCallToExecCall.clear(); this.pendingExecOutput.clear(); this.completedExecCalls.clear();
        this.subagentsByCallId.clear(); this.subagentsByPath.clear();
      }
      return;
    }
    const eventTurn = entry.type === 'event_msg' ? entry.payload?.turn_id : undefined;
    if (eventTurn && eventTurn !== this.currentTurn &&
      (entry.payload.type === 'task_started' || entry.payload.item?.type === 'UserMessage')) {
      this.currentTurn = eventTurn; this.userSeen = false;
      this.turnStarts.push({ id: eventTurn, offset: this.messages.length, tokenUsage: this.tokenUsage });
    }
    if (entry.type === 'event_msg' && entry.payload?.type === 'token_count' && entry.payload?.info) {
      this.tokenUsage = buildCodexTokenBudget(entry.payload.info);
    }

    // Codex records a compaction as a `compacted` rollout entry (with the
    // replayed history that replaced the transcript) and, redundantly, a
    // `context_compacted` event right after it. Only the first is turned
    // into a marker — emitting both would draw two dividers for one
    // compaction.
    if (entry.type === 'compacted') {
      this.messages.push({
        type: 'compact_boundary',
        timestamp: entry.timestamp,
        summary: extractCodexCompactionSummary(entry.payload as AnyRecord),
      });
    }

    if (
      entry.type === 'event_msg'
      && entry.payload?.type === 'sub_agent_activity'
      && entry.payload.kind === 'started'
    ) {
      const eventId = readNonEmptyString(entry.payload.event_id);
      const agentPath = readNonEmptyString(entry.payload.agent_path);
      const subagent = eventId ? this.subagentsByCallId.get(eventId) : undefined;
      if (subagent && agentPath) {
        subagent.agentPath = agentPath;
        this.subagentsByPath.set(agentPath, subagent);
      }
    }

    if (entry.type === 'event_msg' && isVisibleCodexUserMessage(entry.payload as AnyRecord)) {
      this.messages.push({
        type: 'user',
        uuid: !this.userSeen && this.currentTurn ? `codex-turn-${this.currentTurn}` : undefined,
        timestamp: entry.timestamp,
        message: {
          role: 'user',
          content: entry.payload.message,
        },
        images: extractCodexUserImages(entry.payload as AnyRecord),
      });
      this.userSeen = true;
    }

    // Current Codex emits completed UserMessage items instead of the legacy
    // user_message event. Read the event, not response_item user context:
    // the latter also includes injected instructions and compacted history.
    if (entry.type === 'event_msg' && entry.payload?.type === 'item_completed'
      && entry.payload.item?.type === 'UserMessage') {
      const content = extractCodexTextContent(entry.payload.item.content);
      const images = extractCodexUserImages(entry.payload.item as AnyRecord);
      if (content.trim() || images?.length) {
        this.messages.push({ type: 'user', timestamp: entry.timestamp,
          uuid: !this.userSeen && this.currentTurn ? `codex-turn-${this.currentTurn}` : undefined,
          message: { role: 'user', content }, images });
        this.userSeen = true;
      }
    }

    if (
      entry.type === 'response_item' &&
      entry.payload?.type === 'message' &&
      entry.payload.role === 'assistant'
    ) {
      const textContent = extractCodexTextContent(entry.payload.content);
      if (textContent.trim()) {
        this.messages.push({
          type: 'assistant',
          // The persisted and live copies share the provider item ID, but their
          // timestamps can differ by milliseconds. Native replay needs identity.
          uuid: entry.payload.id,
          timestamp: entry.timestamp,
          message: {
            role: 'assistant',
            content: textContent,
          },
        });
      }
    }

    if (entry.type === 'response_item' && entry.payload?.type === 'reasoning') {
      const summaryText = Array.isArray(entry.payload.summary)
        ? entry.payload.summary
            .map((item: AnyRecord) => item?.text)
            .filter(Boolean)
            .join('\n')
        : '';

      if (summaryText.trim()) {
        this.messages.push({
          type: 'thinking',
          timestamp: entry.timestamp,
          message: {
            role: 'assistant',
            content: summaryText,
          },
        });
      }
    }

    if (entry.type === 'response_item' && entry.payload?.type === 'agent_message') {
      const agentMessage = parseCodexSubagentMessage(entry.payload as AnyRecord);
      if (agentMessage && agentMessage.messageType === 'FINAL_ANSWER' && agentMessage.result) {
        let subagent = this.subagentsByPath.get(agentMessage.author);
        if (!subagent) {
          const fallbackCallId = entry.payload.id || generateMessageId('codex-subagent');
          const taskName = agentMessage.author.split('/').filter(Boolean).pop() || 'agent';
          const taskMessage: AnyRecord = {
            uuid: fallbackCallId,
            type: 'tool_use',
            timestamp: entry.timestamp,
            toolName: 'Task',
            toolInput: JSON.stringify({
              subagent_type: 'Codex',
              description: humanizeCodexToolName(taskName),
            }),
            toolCallId: fallbackCallId,
          };
          this.messages.push(taskMessage);
          subagent = {
            toolCallId: fallbackCallId,
            message: taskMessage,
            agentPath: agentMessage.author,
            isComplete: false,
          };
          this.subagentsByCallId.set(fallbackCallId, subagent);
          this.subagentsByPath.set(agentMessage.author, subagent);
        }

        if (!subagent.isComplete) {
          this.messages.push({
            type: 'tool_result',
            timestamp: entry.timestamp,
            toolCallId: subagent.toolCallId,
            output: agentMessage.result,
          });
          subagent.isComplete = true;
        }
      }
    }

    if (entry.type === 'response_item' && entry.payload?.type === 'function_call') {
      let toolName = entry.payload.name;
      let toolInput = entry.payload.arguments;

      if (toolName === 'spawn_agent') {
        let taskName = 'agent';
        try {
          const args = JSON.parse(String(entry.payload.arguments || '{}')) as AnyRecord;
          taskName = readNonEmptyString(args.task_name) || taskName;
        } catch {
          // The activity event can still provide the canonical agent path.
        }

        const taskMessage: AnyRecord = {
          uuid: entry.payload.call_id,
          type: 'tool_use',
          timestamp: entry.timestamp,
          toolName: 'Task',
          toolInput: JSON.stringify({
            subagent_type: 'Codex',
            description: humanizeCodexToolName(taskName),
          }),
          toolCallId: entry.payload.call_id,
        };
        this.messages.push(taskMessage);
        this.subagentsByCallId.set(entry.payload.call_id, {
          toolCallId: entry.payload.call_id,
          message: taskMessage,
          isComplete: false,
        });
        this.ignoredToolCallIds.add(entry.payload.call_id);
        return;
      }

      if (toolName === 'wait') {
        try {
          const args = JSON.parse(String(entry.payload.arguments || '{}')) as AnyRecord;
          const cellId = String(args.cell_id || '');
          const execCallId = this.execCallByCellId.get(cellId);
          if (execCallId) {
            this.waitCallToExecCall.set(entry.payload.call_id, execCallId);
          }
        } catch {
          // Suppress the orchestration wait even when its payload is malformed.
        }
        this.ignoredToolCallIds.add(entry.payload.call_id);
        return;
      }

      if (CODEX_COLLABORATION_CONTROL_TOOLS.has(toolName)) {
        this.ignoredToolCallIds.add(entry.payload.call_id);
        return;
      }

      if (toolName === 'shell_command') {
        toolName = 'Bash';
        try {
          const args = JSON.parse(entry.payload.arguments) as AnyRecord;
          toolInput = JSON.stringify({ command: args.command });
        } catch {
          // Keep original arguments when parsing fails.
        }
      }

      this.messages.push({
        type: 'tool_use',
        timestamp: entry.timestamp,
        toolName,
        toolInput,
        toolCallId: entry.payload.call_id,
      });
    }

    if (entry.type === 'response_item' && entry.payload?.type === 'function_call_output') {
      const waitExecCallId = this.waitCallToExecCall.get(entry.payload.call_id);
      if (waitExecCallId) {
        const output = extractCodexToolOutput(entry.payload.output);
        const runningOutput = readRunningExecOutput(output);
        const accumulatedOutput = `${this.pendingExecOutput.get(waitExecCallId) || ''}${runningOutput?.content ?? output}`;
        this.pendingExecOutput.set(waitExecCallId, accumulatedOutput);

        if (!runningOutput && !this.completedExecCalls.has(waitExecCallId)) {
          this.messages.push({
            type: 'tool_result',
            timestamp: entry.timestamp,
            toolCallId: waitExecCallId,
            output: accumulatedOutput,
          });
          this.completedExecCalls.add(waitExecCallId);
        }
        return;
      }

      const subagent = this.subagentsByCallId.get(entry.payload.call_id);
      if (subagent) {
        const output = extractCodexToolOutput(entry.payload.output);
        try {
          const taskPath = readNonEmptyString((JSON.parse(output) as AnyRecord).task_name);
          if (taskPath) {
            subagent.agentPath = taskPath;
            this.subagentsByPath.set(taskPath, subagent);
          }
        } catch {
          // The sub_agent_activity event normally supplies the path.
        }
        return;
      }

      if (this.ignoredToolCallIds.has(entry.payload.call_id)) {
        return;
      }

      this.messages.push({
        type: 'tool_result',
        timestamp: entry.timestamp,
        toolCallId: entry.payload.call_id,
        output: extractCodexToolOutput(entry.payload.output),
        images: extractToolResultImages(entry.payload.output),
      });
    }

    if (entry.type === 'response_item' && entry.payload?.type === 'custom_tool_call') {
      let toolName = entry.payload.name || 'custom_tool';
      const input = entry.payload.input || '';
      let toolInput = input;

      if (toolName === 'exec') {
        const translated = translateCodexExecInput(input);
        if (translated) {
          toolName = translated.toolName;
          toolInput = translated.toolInput;
        }
        this.messages.push({
          type: 'tool_use',
          timestamp: entry.timestamp,
          toolName,
          toolInput,
          toolCallId: entry.payload.call_id,
        });
        this.execToolCallIds.add(entry.payload.call_id);
        return;
      }

      if (toolName === 'apply_patch') {
        const fileMatch = String(input).match(/\*\*\* Update File: (.+)/);
        const filePath = fileMatch ? fileMatch[1].trim() : 'unknown';
        const lines = String(input).split('\n');
        const oldLines: string[] = [];
        const newLines: string[] = [];

        for (const lineContent of lines) {
          if (lineContent.startsWith('-') && !lineContent.startsWith('---')) {
            oldLines.push(lineContent.slice(1));
          } else if (lineContent.startsWith('+') && !lineContent.startsWith('+++')) {
            newLines.push(lineContent.slice(1));
          }
        }

        this.messages.push({
          type: 'tool_use',
          timestamp: entry.timestamp,
          toolName: 'Edit',
          toolInput: JSON.stringify({
            file_path: filePath,
            old_string: oldLines.join('\n'),
            new_string: newLines.join('\n'),
          }),
          toolCallId: entry.payload.call_id,
        });
      } else {
        this.messages.push({
          type: 'tool_use',
          timestamp: entry.timestamp,
          toolName,
          toolInput: input,
          toolCallId: entry.payload.call_id,
        });
      }
    }

    if (entry.type === 'response_item' && entry.payload?.type === 'custom_tool_call_output') {
      if (this.ignoredToolCallIds.has(entry.payload.call_id)) {
        return;
      }

      const output = extractCodexToolOutput(entry.payload.output);
      if (this.execToolCallIds.has(entry.payload.call_id)) {
        const runningOutput = readRunningExecOutput(output);
        if (runningOutput) {
          this.execCallByCellId.set(runningOutput.cellId, entry.payload.call_id);
          this.pendingExecOutput.set(entry.payload.call_id, runningOutput.content);
          return;
        }
        this.completedExecCalls.add(entry.payload.call_id);
      }

      this.messages.push({
        type: 'tool_result',
        timestamp: entry.timestamp,
        toolCallId: entry.payload.call_id,
        output,
        images: extractToolResultImages(entry.payload.output),
      });
    }
  }
}

async function getCodexSessionMessages(sessionId: string): Promise<CodexHistoryResult> {
  try {
    const sessionFilePath = sessionsDb.getSessionById(sessionId)?.jsonl_path;

    if (!sessionFilePath) {
      console.warn(`Codex session file not found for session ${sessionId}`);
      return { messages: [], total: 0, hasMore: false };
    }

    const { parser, generation } = await readCodexRollout(sessionFilePath, () => new CodexRolloutParser());
    return { messages: parser.sortedMessages(generation), tokenUsage: parser.tokenUsage, view: { parser, generation } };
  } catch (error) {
    console.error(`Error reading Codex session messages for ${sessionId}:`, error);
    return { messages: [], total: 0, hasMore: false };
  }
}

/** The Codex provider uses this adapter for history and normalized runtime events. */
export class CodexSessionsProvider implements IProviderSessions {
  /**
   * Normalizes a persisted Codex JSONL entry.
   *
   * Live Codex SDK events are transformed before they reach normalizeMessage(),
   * while history entries already use a compact message/tool shape from projects.js.
   */
  private normalizeHistoryEntry(raw: AnyRecord, sessionId: string | null): NormalizedMessage[] {
    const ts = raw.timestamp || new Date().toISOString();
    const baseId = raw.uuid || raw.id || generateMessageId('codex');

    if (raw.type === 'compact_boundary') {
      return [createCompactBoundaryMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        summary: typeof raw.summary === 'string' ? raw.summary : undefined,
      })];
    }

    if (raw.type === 'thinking' || raw.isReasoning) {
      const thinkingContent = typeof raw.message?.content === 'string'
        ? raw.message.content
        : '';
      if (!thinkingContent.trim()) {
        return [];
      }
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'thinking',
        content: thinkingContent,
      })];
    }

    if (raw.message?.role === 'user') {
      const content = typeof raw.message.content === 'string'
        ? raw.message.content
        : Array.isArray(raw.message.content)
          ? raw.message.content
              .map((part: string | AnyRecord) => typeof part === 'string' ? part : part?.text || '')
              .filter(Boolean)
              .join('\n')
          : String(raw.message.content || '');
      const parsedFiles = parseFilesInputTag(content);
      const rawImages = Array.isArray(raw.images) && raw.images.length > 0 ? raw.images : undefined;
      const files = parsedFiles.attachments.length > 0 ? parsedFiles.attachments : undefined;
      if (!parsedFiles.text.trim() && !rawImages && !files) {
        return [];
      }
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'text',
        role: 'user',
        uuid: raw.uuid,
        content: parsedFiles.text,
        images: rawImages,
        files,
      })];
    }

    if (raw.message?.role === 'assistant') {
      const content = typeof raw.message.content === 'string'
        ? raw.message.content
        : Array.isArray(raw.message.content)
          ? raw.message.content
              .map((part: string | AnyRecord) => typeof part === 'string' ? part : part?.text || '')
              .filter(Boolean)
              .join('\n')
          : '';
      if (!content.trim()) {
        return [];
      }
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'text',
        role: 'assistant',
        content,
      })];
    }

    if (raw.type === 'tool_use' || raw.toolName) {
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'tool_use',
        toolName: raw.toolName || 'Unknown',
        toolInput: raw.toolInput,
        toolId: raw.toolCallId || baseId,
      })];
    }

    if (raw.type === 'tool_result') {
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'tool_result',
        toolId: raw.toolCallId || '',
        content: raw.output || '',
        images: raw.images,
        isError: Boolean(raw.isError),
      })];
    }

    return [];
  }

  /**
   * Normalizes either a Codex history entry or a transformed live SDK event.
   */
  normalizeMessage(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    const raw = readObjectRecord(rawMessage);
    if (!raw) {
      return [];
    }

    // Live items also carry message.role. Dispatch them by itemType first:
    // treating a reasoning item as history turns it into ordinary assistant
    // text, contaminating title/recap JSON with the model's draft answer.
    if ((raw.type !== 'item' && raw.message?.role) || raw.type === 'compact_boundary') {
      return this.normalizeHistoryEntry(raw, sessionId);
    }

    const ts = raw.timestamp || new Date().toISOString();
    const baseId = raw.uuid || raw.id || generateMessageId('codex');

    if (raw.type === 'item') {
      switch (raw.itemType) {
        case 'agent_message':
          return [createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'text',
            role: 'assistant',
            content: raw.message?.content || '',
          })];
        case 'reasoning':
          return [createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'thinking',
            content: raw.message?.content || '',
          })];
        case 'command_execution':
          return [createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'tool_use',
            toolName: 'Bash',
            toolInput: { command: raw.command },
            toolId: baseId,
            output: raw.output,
            exitCode: raw.exitCode,
            status: raw.status,
          })];
        case 'file_change':
          return [createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'tool_use',
            toolName: 'FileChanges',
            toolInput: raw.changes,
            toolId: baseId,
            status: raw.status,
          })];
        case 'mcp_tool_call':
          return [createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'tool_use',
            toolName: raw.tool || 'MCP',
            toolInput: raw.arguments,
            toolId: baseId,
            server: raw.server,
            result: raw.result,
            error: raw.error,
            status: raw.status,
          })];
        case 'web_search':
          return [createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'tool_use',
            toolName: 'WebSearch',
            toolInput: { query: raw.query },
            toolId: baseId,
          })];
        case 'todo_list':
          return [createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'tool_use',
            toolName: 'TodoList',
            toolInput: { items: raw.items },
            toolId: baseId,
          })];
        case 'error':
          return [createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'error',
            content: raw.message?.content || 'Unknown error',
          })];
        default:
          return [createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'tool_use',
            toolName: raw.itemType || 'Unknown',
            toolInput: raw.item || raw,
            toolId: baseId,
          })];
      }
    }

    if (raw.type === 'turn_complete') {
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'complete',
      })];
    }
    if (raw.type === 'turn_failed') {
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'error',
        content: raw.error?.message || 'Turn failed',
      })];
    }

    return [];
  }

  /**
   * Loads Codex JSONL history and keeps token usage metadata when projects.js
   * provides it.
   */
  async fetchHistory(
    sessionId: string,
    options: FetchHistoryOptions = {},
  ): Promise<FetchHistoryResult> {
    const { limit = null, offset = 0 } = options;

    const row = sessionsDb.getSessionById(sessionId);
    const canonical = await readCodexRevertedHistory(row?.provider_session_id || sessionId, Boolean(row?.is_private));
    let result: CodexHistoryResult;
    try {
      // Load full history first so `total` reflects frontend-normalized messages,
      // not raw JSONL records.
      result = canonical === undefined ? await getCodexSessionMessages(sessionId) : { messages: canonical };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[CodexProvider] Failed to load session ${sessionId}:`, message);
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    }

    const tokenUsage = Array.isArray(result) ? undefined : result.tokenUsage;
    const view = Array.isArray(result) ? undefined : result.view;
    // An unchanged rollout reuses the normalized list built for the previous
    // page instead of re-normalizing every message of a large session.
    const cached = view?.parser.normalizedView;
    const reusable = cached && cached.generation === view?.generation && cached.sessionId === sessionId ? cached : null;
    const { messages: normalized, total } = reusable
      ?? this.normalizeHistory(Array.isArray(result) ? result : (result.messages || []), sessionId);
    if (view && !reusable) {
      view.parser.normalizedView = { generation: view.generation, sessionId, messages: normalized, total };
    }
    const normalizedOffset = Math.max(0, offset);
    const normalizedLimit = limit === null ? null : Math.max(0, limit);
    const { page, hasMore } = sliceTailPage(normalized, normalizedLimit, normalizedOffset);

    return {
      // The normalized list may be cached for later pages; hand out copies.
      messages: page.map(message => ({ ...message })),
      total,
      hasMore,
      offset: normalizedOffset,
      limit: normalizedLimit,
      tokenUsage,
    };
  }

  /** Normalizes raw history entries and attaches each tool result to its call. */
  private normalizeHistory(rawMessages: AnyRecord[], sessionId: string): { messages: NormalizedMessage[]; total: number } {
    const normalized: NormalizedMessage[] = [];
    for (const raw of rawMessages) {
      normalized.push(...(raw.type === 'item' ? this.normalizeMessage(raw, sessionId) : this.normalizeHistoryEntry(raw, sessionId)));
    }

    const toolResultMap = new Map<string, NormalizedMessage>();
    for (const msg of normalized) {
      if (msg.kind === 'tool_result' && msg.toolId) {
        toolResultMap.set(msg.toolId, msg);
      }
    }
    for (const msg of normalized) {
      if (msg.kind === 'tool_use' && msg.toolId && toolResultMap.has(msg.toolId)) {
        const toolResult = toolResultMap.get(msg.toolId);
        if (toolResult) {
          msg.toolResult = {
            content: toolResult.content,
            isError: toolResult.isError,
            ...(toolResult.images ? { images: toolResult.images } : {}),
          };
        }
      }
    }

    let total = 0;
    for (const msg of normalized) {
      if (msg.kind !== 'tool_result') {
        total += 1;
      }
    }
    return { messages: normalized, total };
  }
}
