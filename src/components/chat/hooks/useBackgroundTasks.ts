import { useMemo } from 'react';
import type { ChatMessage } from '../types/types';

/**
 * Background bash tasks (Claude Code `run_in_background`) derived from the chat
 * stream. A launch shows up as a Bash tool_result — "Command running in
 * background with ID: <id>. Output is being written to: <path>." — and a
 * completion as a `<task-notification>` (same id) with a status + summary.
 */

// 'ended' = launched, no completion record, and the session is idle — so the
// task is over (SDK background tasks die when a turn ends), we just don't have
// its exit code. Distinct from 'running' so an idle history view doesn't show a
// misleading spinner.
export type BackgroundTaskStatus = 'running' | 'completed' | 'failed' | 'ended';

export type BackgroundTask = {
  id: string;
  label: string;
  status: BackgroundTaskStatus;
  exitCode: number | null;
  outputFile: string | null;
};

type TaskNotification = { taskId?: string; status?: string; summary?: string };

// `\S+?\.output` anchors on the file suffix so the trailing sentence period
// ("…/tasks/<id>.output. You will be notified…") isn't captured into the path.
const LAUNCH_RE = /Command running in background with ID:\s*([A-Za-z0-9_-]+)\.\s*Output is being written to:\s*(\S+?\.output)/;

function parseToolInput(toolInput: unknown): { command?: string; description?: string } {
  if (typeof toolInput !== 'string') return {};
  try {
    const parsed = JSON.parse(toolInput);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function labelFromCommand(command?: string): string {
  if (!command) return 'background command';
  const firstLine = command.split('\n')[0].trim();
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine;
}

export function deriveBackgroundTasks(messages: ChatMessage[], isSessionActive = false): BackgroundTask[] {
  // First pass: completions keyed by task id. A notification message may carry
  // several completions (taskNotifications[]); fall back to the single-id form.
  const completions = new Map<string, { status: string; exitCode: number | null }>();
  const recordCompletion = (taskId: string | undefined, status: string | undefined, summary: string | undefined) => {
    if (!taskId) return;
    const exitMatch = (summary || '').match(/exit code\s*(\d+)/i);
    completions.set(taskId, { status: status || 'completed', exitCode: exitMatch ? Number(exitMatch[1]) : null });
  };
  for (const msg of messages) {
    if (!msg.isTaskNotification) continue;
    const notifs = (msg as { taskNotifications?: TaskNotification[] }).taskNotifications;
    if (notifs && notifs.length) {
      for (const n of notifs) recordCompletion(n.taskId, n.status, n.summary);
    } else {
      const summary = typeof msg.content === 'string' ? msg.content : '';
      recordCompletion((msg as { taskId?: string }).taskId, (msg as { taskStatus?: string }).taskStatus, summary);
    }
  }

  // Second pass: launches (in order), correlated with completions by id.
  const tasks: BackgroundTask[] = [];
  const seen = new Set<string>();
  for (const msg of messages) {
    if (!msg.isToolUse) continue;
    const content = msg.toolResult?.content;
    if (typeof content !== 'string') continue;
    const match = content.match(LAUNCH_RE);
    if (!match) continue;

    const id = match[1];
    if (seen.has(id)) continue;
    seen.add(id);

    const { command, description } = parseToolInput(msg.toolInput);
    const completion = completions.get(id);
    let status: BackgroundTaskStatus;
    if (completion) {
      status = completion.exitCode !== null && completion.exitCode !== 0 ? 'failed' : 'completed';
    } else {
      // No completion seen: still running only if the session is live; otherwise
      // the turn ended and the task is over (we just lack its exit code).
      status = isSessionActive ? 'running' : 'ended';
    }

    tasks.push({
      id,
      label: description?.trim() || labelFromCommand(command),
      status,
      exitCode: completion?.exitCode ?? null,
      outputFile: match[2] || null,
    });
  }

  return tasks;
}

export function useBackgroundTasks(messages: ChatMessage[], isSessionActive = false) {
  return useMemo(() => {
    const tasks = deriveBackgroundTasks(messages, isSessionActive);
    // Running first, then most-recent launches; keep it small and glanceable.
    const running = tasks.filter((t) => t.status === 'running');
    const done = tasks.filter((t) => t.status !== 'running');
    return {
      tasks: [...running, ...done.reverse()],
      runningCount: running.length,
      total: tasks.length,
    };
  }, [messages, isSessionActive]);
}
