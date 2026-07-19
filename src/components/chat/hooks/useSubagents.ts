import { useMemo } from 'react';
import type { ChatMessage } from '../types/types';

/**
 * Subagents (Claude Code `Task` tool spawns) derived from the chat stream. Each
 * `Task` tool-use is one subagent; its conversation lives in a sidechain
 * transcript (suppressed from the main thread) fetched on demand for the viewer.
 */
export type Subagent = {
  /** Stable list key. */
  key: string;
  /** Transcript id (`agent-<agentId>.jsonl`); null until the Task completes. */
  agentId: string | null;
  /** Human label — the Task description, falling back to the subagent type. */
  label: string;
  subagentType: string | null;
  prompt: string | null;
  status: 'running' | 'completed' | 'failed';
  toolCount: number;
};

function parseInput(toolInput: unknown): { subagent_type?: string; description?: string; prompt?: string } {
  if (typeof toolInput === 'string') {
    try {
      const parsed = JSON.parse(toolInput);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return toolInput && typeof toolInput === 'object' ? (toolInput as Record<string, string>) : {};
}

export function deriveSubagents(messages: ChatMessage[]): Subagent[] {
  const subagents: Subagent[] = [];
  let index = 0;

  // Async (background) subagents get their Task tool_result immediately at
  // launch (`status: 'async_launched'`), so the tool_result alone does not mean
  // the agent finished. Completion arrives later as a <task-notification>
  // whose task-id equals the agentId — collect those statuses first.
  const notifiedStatus = new Map<string, string>();
  for (const msg of messages) {
    const notifications = (msg as { taskNotifications?: Array<{ taskId?: string; status?: string }> }).taskNotifications;
    if (!Array.isArray(notifications)) continue;
    for (const notification of notifications) {
      if (notification?.taskId) {
        notifiedStatus.set(String(notification.taskId), notification.status || 'completed');
      }
    }
  }

  for (const msg of messages) {
    if (!msg.isSubagentContainer) continue;
    index += 1;

    const input = parseInput(msg.toolInput);
    const toolUseResult = (msg.toolResult?.toolUseResult ?? null) as { agentId?: string; status?: string } | null;
    const agentId = toolUseResult?.agentId ? String(toolUseResult.agentId) : null;
    let isComplete = msg.subagentState?.isComplete ?? Boolean(msg.toolResult);
    let isError = Boolean(msg.toolResult?.isError);
    if (toolUseResult?.status === 'async_launched' && agentId) {
      const notified = notifiedStatus.get(agentId);
      isComplete = notified !== undefined;
      isError = notified === 'failed' || notified === 'error';
    }

    subagents.push({
      key: agentId || msg.toolId || `subagent-${index}`,
      agentId,
      label: (input.description || input.subagent_type || 'subagent').trim(),
      subagentType: input.subagent_type ?? null,
      prompt: input.prompt ?? null,
      status: !isComplete ? 'running' : isError ? 'failed' : 'completed',
      toolCount: msg.subagentState?.childTools.length ?? 0,
    });
  }

  return subagents;
}

export function useSubagents(messages: ChatMessage[]) {
  return useMemo(() => {
    const subagents = deriveSubagents(messages);
    const running = subagents.filter((s) => s.status === 'running').length;
    return { subagents, runningCount: running, total: subagents.length };
  }, [messages]);
}
