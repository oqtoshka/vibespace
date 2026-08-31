/**
 * Message normalization utilities.
 * Converts NormalizedMessage[] from the session store into ChatMessage[] for the UI.
 */

import type { NormalizedMessage } from '../../../stores/useSessionStore';
import type { ChatMessage, SubagentChildTool } from '../types/types';
import { formatUsageLimitText } from '../utils/chatFormatting';

function formatToolResultContent(content: unknown): string {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  const toolUseErrorMatch = /^<tool_use_error>([\s\S]*)<\/tool_use_error>$/.exec(text.trim());
  return toolUseErrorMatch ? toolUseErrorMatch[1] : text;
}

type ParsedTaskNotification = {
  status: string;
  summary: string;
  result: string;
};

/**
 * Extracts the optional `<result>` markdown payload from a notification body.
 * Tolerates a missing `</result>` close tag (truncated notifications).
 */
function extractTaskResult(body: string): string {
  const resultOpen = body.indexOf('<result>');
  if (resultOpen === -1) return '';
  const afterOpen = body.slice(resultOpen + '<result>'.length);
  const closeIndex = afterOpen.indexOf('</result>');
  return closeIndex === -1
    ? afterOpen.replace(/<\/task-notification>\s*$/, '').trim()
    : afterOpen.slice(0, closeIndex).trim();
}

/**
 * Parses a background-agent `<task-notification>` block.
 *
 * The harness injects these as user-role messages when a background task stops.
 * Newer notifications carry extra fields (`<tool-use-id>`, `<note>`, `<usage>`,
 * and a `<result>` markdown payload) that the previous single-shot regex could
 * not match, so the whole raw XML block leaked through as plain user text.
 * Fields are extracted independently so the block renders as an assistant
 * notification plus, when present, the agent's markdown result.
 */
function parseTaskNotification(content: string): ParsedTaskNotification | null {
  if (!content.trimStart().startsWith('<task-notification>')) {
    return null;
  }

  const statusMatch = /<status>([\s\S]*?)<\/status>/.exec(content);
  const summaryMatch = /<summary>([\s\S]*?)<\/summary>/.exec(content);

  let result = '';
  const resultOpen = content.indexOf('<result>');
  if (resultOpen !== -1) {
    const afterOpen = content.slice(resultOpen + '<result>'.length);
    const closeIndex = afterOpen.indexOf('</result>');
    result =
      closeIndex === -1
        ? afterOpen.replace(/<\/task-notification>\s*$/, '').trim()
        : afterOpen.slice(0, closeIndex).trim();
  }

  return {
    status: statusMatch?.[1]?.trim() || 'completed',
    summary: summaryMatch?.[1]?.trim() || 'Background task finished',
    result,
  };
}

/**
 * Convert NormalizedMessage[] from the session store into ChatMessage[]
 * that the existing UI components expect.
 *
 * Truly internal/system content is already filtered server-side. Some Claude
 * transcript artifacts such as local slash commands and compact summaries are
 * intentionally preserved and annotated so they can render like normal chat.
 */
export function normalizedToChatMessages(messages: NormalizedMessage[]): ChatMessage[] {
  const converted: ChatMessage[] = [];

  // First pass: collect tool results for attachment
  const toolResultMap = new Map<string, NormalizedMessage>();
  const toolUseIds = new Set<string>();
  for (const msg of messages) {
    if (msg.kind === 'tool_use' && msg.toolId) {
      toolUseIds.add(msg.toolId);
    }

    if (msg.kind === 'tool_result' && msg.toolId) {
      toolResultMap.set(msg.toolId, msg);
    }
  }

  for (const msg of messages) {
    const sharedMetadata = {
      // Carry the source id through so the UI can derive a stable React key
      // (getIntrinsicMessageKey prefers `id`). Without it, text/thinking rows
      // fall back to timestamp+content — and the streaming row's timestamp is
      // rewritten on every delta flush, churning the key and remounting bubbles.
      id: msg.id,
      // Clean transcript anchor for rewind/edit-in-place (user messages only).
      uuid: msg.uuid,
      displayText: msg.displayText,
      commandName: msg.commandName,
      commandMessage: msg.commandMessage,
      commandArgs: msg.commandArgs,
      isLocalCommand: msg.isLocalCommand,
      isLocalCommandStdout: msg.isLocalCommandStdout,
      isCompactSummary: msg.isCompactSummary,
    };

    switch (msg.kind) {
      case 'text': {
        const content = msg.content || '';
        const images = Array.isArray(msg.images) && msg.images.length > 0 ? msg.images : undefined;
        const files = Array.isArray(msg.files) && msg.files.length > 0 ? msg.files : undefined;
        if (!content.trim() && !images && !files) continue;

        if (msg.role === 'user') {
          // Parse background-task completion notifications. Extract fields
          // individually so we tolerate field order and the optional
          // <tool-use-id> line the harness includes (the old strict regex
          // missed those, leaking raw XML into the transcript). A message can
          // batch several completions — capture them all; a block with no
          // closing tag (truncated) is handled by the single-shot fallback.
          const notifBlocks = [...content.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)];
          const fallbackNotif = notifBlocks.length === 0 ? parseTaskNotification(content) : null;
          if (notifBlocks.length > 0 || fallbackNotif) {
            const taskNotifications = notifBlocks.length > 0
              ? notifBlocks.map((block) => {
                  const body = block[1];
                  return {
                    taskId: body.match(/<task-id>([^<]*)<\/task-id>/)?.[1]?.trim(),
                    status: body.match(/<status>([^<]*)<\/status>/)?.[1]?.trim() || 'completed',
                    summary: body.match(/<summary>([^<]*)<\/summary>/)?.[1]?.trim(),
                    result: extractTaskResult(body),
                  };
                })
              : [{ taskId: undefined, ...fallbackNotif! }];
            const last = taskNotifications[taskNotifications.length - 1];
            converted.push({
              type: 'assistant',
              content: last.summary || 'Background task finished',
              timestamp: msg.timestamp,
              isTaskNotification: true,
              taskStatus: last.status,
              taskId: taskNotifications[0].taskId,
              taskNotifications,
              ...sharedMetadata,
            });
            // Render each agent's result as a normal assistant message so its
            // markdown displays correctly instead of leaking raw XML.
            for (const notif of taskNotifications) {
              if (notif.result) {
                converted.push({
                  type: 'assistant',
                  content: formatUsageLimitText(notif.result),
                  timestamp: msg.timestamp,
                  ...sharedMetadata,
                });
              }
            }
          } else {
            converted.push({
              type: 'user',
              content,
              timestamp: msg.timestamp,
              images,
              files,
              ...sharedMetadata,
            });
          }
        } else {
          const text = formatUsageLimitText(content);
          converted.push({
            type: 'assistant',
            content: text,
            timestamp: msg.timestamp,
            ...sharedMetadata,
          });
        }
        break;
      }

      case 'tool_use': {
        const tr = msg.toolResult || (msg.toolId ? toolResultMap.get(msg.toolId) : null);
        // Both the classic `Task` tool and the newer `Agent` tool (FleetView)
        // spawn subagents whose transcript lands in agent-<id>.jsonl; treat both
        // as subagent containers so their conversation is nested/threaded rather
        // than leaking the subagent's prompt as a fake user message.
        const isSubagentContainer = msg.toolName === 'Task' || msg.toolName === 'Agent';

        // Build child tools from subagentTools
        const childTools: SubagentChildTool[] = [];
        if (isSubagentContainer && msg.subagentTools && Array.isArray(msg.subagentTools)) {
          for (const tool of msg.subagentTools as any[]) {
            childTools.push({
              toolId: tool.toolId,
              toolName: tool.toolName,
              toolInput: tool.toolInput,
              toolResult: tool.toolResult || null,
              timestamp: new Date(tool.timestamp || Date.now()),
            });
          }
        }

        const toolResult = tr
          ? {
              content: formatToolResultContent(tr.content),
              isError: Boolean(tr.isError),
              images: Array.isArray(tr.images) ? tr.images : undefined,
              toolUseResult: (tr as any).toolUseResult,
              interruptedByShutdown: Boolean((tr as any).interruptedByShutdown),
            }
          : null;

        converted.push({
          type: 'assistant',
          content: '',
          timestamp: msg.timestamp,
          isToolUse: true,
          toolName: msg.toolName,
          toolInput: typeof msg.toolInput === 'string' ? msg.toolInput : JSON.stringify(msg.toolInput ?? '', null, 2),
          toolId: msg.toolId,
          toolResult,
          isSubagentContainer,
          subagentState: isSubagentContainer
            ? {
                childTools,
                currentToolIndex: childTools.length > 0 ? childTools.length - 1 : -1,
                isComplete: Boolean(toolResult),
              }
            : undefined,
          ...sharedMetadata,
        });
        break;
      }

      case 'thinking':
        if (msg.content?.trim()) {
          converted.push({
            type: 'assistant',
            content: msg.content,
            timestamp: msg.timestamp,
            isThinking: true,
            ...sharedMetadata,
          });
        }
        break;

      case 'error':
        converted.push({
          type: 'error',
          content: msg.content || 'Unknown error',
          timestamp: msg.timestamp,
          ...sharedMetadata,
        });
        break;

      case 'interactive_prompt':
        converted.push({
          type: 'assistant',
          content: msg.content || '',
          timestamp: msg.timestamp,
          isInteractivePrompt: true,
          ...sharedMetadata,
        });
        break;

      case 'task_notification':
        converted.push({
          type: 'assistant',
          content: msg.summary || 'Background task update',
          timestamp: msg.timestamp,
          isTaskNotification: true,
          taskStatus: msg.status || 'completed',
          ...sharedMetadata,
        });
        break;

      // The seam where the conversation was summarized. Rendered as a marker
      // rather than a bubble: what matters is that everything above it is no
      // longer in the model's context, and roughly how much was dropped — the
      // summary itself is there to expand, not to read by default.
      //
      // Claude records one compaction as two rows: the boundary carrying the
      // token metrics, immediately followed by the summary it replayed into the
      // next turn. Fold that pair into a single marker instead of drawing two
      // dividers, one of them blank. Only a summary-bearing row merges into a
      // summary-less one, so two genuine back-to-back compactions still read as
      // two seams.
      case 'compact_boundary': {
        const previous = converted[converted.length - 1];
        if (previous?.isCompactBoundary && !previous.compaction?.summary && msg.compaction?.summary) {
          previous.compaction = {
            ...(previous.compaction ?? { trigger: 'manual' as const }),
            summary: msg.compaction.summary,
          };
          break;
        }
        converted.push({
          type: 'system',
          content: '',
          timestamp: msg.timestamp,
          isCompactBoundary: true,
          compaction: msg.compaction,
          ...sharedMetadata,
        });
        break;
      }

      case 'stream_delta':
        if (msg.content) {
          converted.push({
            type: 'assistant',
            content: msg.content,
            timestamp: msg.timestamp,
            isStreaming: true,
            ...sharedMetadata,
          });
        }
        break;

      // stream_end, complete, status, permission_*, session_created
      // are control events — not rendered as messages
      case 'stream_end':
      case 'complete':
      case 'status':
      case 'permission_request':
      case 'permission_cancelled':
      case 'session_created':
        // Skip — these are handled by useChatRealtimeHandlers
        break;

      // tool_result is handled via attachment to tool_use above
      case 'tool_result': {
        if (msg.toolId && toolUseIds.has(msg.toolId)) {
          break;
        }

        // A result with a toolId but no matching tool_use in the loaded set is
        // almost always a tool_use/tool_result pair split across a pagination
        // boundary (older page not loaded yet). Rendering its raw content here
        // produces an unstyled dump that "fixes itself" once the older page
        // loads; skip it and let it attach to its tool_use when that arrives.
        if (msg.toolId) {
          break;
        }

        const content = formatToolResultContent(msg.content || '');
        if (!content.trim()) {
          break;
        }

        converted.push({
          type: msg.isError ? 'error' : 'assistant',
          content,
          timestamp: msg.timestamp,
          toolId: msg.toolId,
          ...sharedMetadata,
        });
        break;
      }

      default:
        break;
    }
  }

  return converted;
}
