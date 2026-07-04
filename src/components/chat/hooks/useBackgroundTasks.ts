import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage } from '../types/types';
import { api } from '../../../utils/api';

/**
 * Background bash tasks (Claude Code `run_in_background`) derived from the chat
 * stream. A launch shows up as a Bash tool_result — "Command running in
 * background with ID: <id>. Output is being written to: <path>." — and a
 * completion as a `<task-notification>` (same id) with a status + summary.
 *
 * The message stream alone is not trustworthy for "is it still running": some
 * task completions are delivered as internal transcript entries the UI never
 * sees, so a finished job stays derived-as-running forever. We therefore
 * reconcile against the server's authoritative pending-task set (polled while
 * anything looks live) — see `useBackgroundTasks`.
 */

// 'ended' = launched, no completion record, session idle and no authoritative
// server signal — the task is over (we just lack its exit code). Distinct from
// 'running' so an idle history view doesn't show a misleading spinner.
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

/**
 * If a Bash tool_result is a `run_in_background` launch acknowledgement, returns
 * its task id + output file; otherwise null. Lets a tool card tell a background
 * launch apart from an ordinary command whose output happens to be that text.
 */
export function parseBackgroundLaunch(content: unknown): { taskId: string; outputFile: string } | null {
  if (typeof content !== 'string') return null;
  const match = content.match(LAUNCH_RE);
  return match ? { taskId: match[1], outputFile: match[2] } : null;
}

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

/**
 * Authoritative running set polled from the server. `null` = not fetched yet
 * (fall back to stream-derived heuristics); a Set (possibly empty) = trusted.
 */
export type ServerRunning = { ids: Set<string>; live: boolean } | null;

export function deriveBackgroundTasks(
  messages: ChatMessage[],
  isSessionActive = false,
  serverRunning: ServerRunning = null,
): BackgroundTask[] {
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
    } else if (serverRunning) {
      // Server is the source of truth: running iff it says so; otherwise the job
      // has finished (its completion just wasn't visible in the stream).
      status = serverRunning.ids.has(id) ? 'running' : 'ended';
    } else {
      // No authoritative data yet: a job survives its launching turn, so treat
      // a live session's un-completed launches as running; an idle one as over.
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

const POLL_INTERVAL_MS = 3000;

export function useBackgroundTasks(
  messages: ChatMessage[],
  isSessionActive = false,
  sessionId: string | null = null,
) {
  const [serverRunning, setServerRunning] = useState<ServerRunning>(null);

  // A launch with neither a completion record nor server confirmation might
  // still be running — that's the signal to keep polling the authoritative set.
  const maybeLive = useMemo(
    () => deriveBackgroundTasks(messages, isSessionActive, serverRunning)
      .some((t) => t.status === 'running' || (t.status === 'ended' && isSessionActive)),
    [messages, isSessionActive, serverRunning],
  );

  const hasAnyTasks = useMemo(
    () => deriveBackgroundTasks(messages, false, null).length > 0,
    [messages],
  );

  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  useEffect(() => {
    // Poll while a session is selected and either something may be running or we
    // haven't yet fetched an authoritative snapshot for the tasks we do have.
    if (!sessionId || (!maybeLive && serverRunning !== null)) {
      return;
    }
    if (!hasAnyTasks && !isSessionActive) {
      return;
    }

    let cancelled = false;
    const controllerRef: { current: AbortController | null } = { current: null };

    const poll = async () => {
      if (sessionIdRef.current !== sessionId) return;
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      try {
        const res = await api.backgroundTasks(sessionId, { signal: controller.signal });
        if (cancelled || !res.ok) return;
        const data = await res.json();
        const ids = new Set<string>(
          Array.isArray(data.running) ? data.running.map((t: { taskId: string }) => t.taskId) : [],
        );
        setServerRunning({ ids, live: Boolean(data.live) });
      } catch {
        /* transient — keep the last snapshot */
      }
    };

    void poll();
    const timer = window.setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      controllerRef.current?.abort();
      window.clearInterval(timer);
    };
  }, [sessionId, maybeLive, hasAnyTasks, isSessionActive, serverRunning]);

  // Reset the authoritative snapshot when switching sessions so one session's
  // running set never bleeds into another.
  useEffect(() => {
    setServerRunning(null);
  }, [sessionId]);

  return useMemo(() => {
    const tasks = deriveBackgroundTasks(messages, isSessionActive, serverRunning);
    // Running first, then most-recent launches; keep it small and glanceable.
    const running = tasks.filter((t) => t.status === 'running');
    const done = tasks.filter((t) => t.status !== 'running');
    return {
      tasks: [...running, ...done.reverse()],
      runningCount: running.length,
      total: tasks.length,
    };
  }, [messages, isSessionActive, serverRunning]);
}
