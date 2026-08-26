import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Reader for the Claude runtime's native task ledger: one JSON file per task
 * under `<config-dir>/tasks/<sessionId>/`, written by the model's own
 * TaskCreate/TaskUpdate calls. The same files a supervisor board's claude-tasks
 * adapter renders — this module never writes them, only asks "is anything
 * still open?" so the session supervisor can decide whether an idle session
 * is actually finished.
 */

export type ClaudeTaskEntry = {
  id: string;
  subject: string;
  status: 'pending' | 'in_progress';
  /**
   * The model marked this task as parked on the user (a question it asked, a
   * decision, a review) via TaskUpdate metadata `{ waitingOnUser: true }`.
   * Such a task is open — the work is not done — but nudging the session
   * cannot advance it; only the user's reply can. Supervisors must neither
   * close it nor keep prodding the model over it.
   */
  waitingOnUser: boolean;
  /** File mtime (ms), for judging whether `waitingOnUser` predates the user's latest reply. Null when stat failed. */
  updatedAt: number | null;
};

function tasksRootDir(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim();
  return path.join(configDir || path.join(os.homedir(), '.claude'), 'tasks');
}

/**
 * Tasks the model declared for this session and has not yet closed.
 * Open is a whitelist (`pending` / `in_progress`) so an unknown future status
 * can never trap a session in an endless nudge loop. A missing directory, the
 * `.lock` file, and half-written JSON (the runtime rewrites files in place)
 * all read as "nothing open".
 */
export async function readOpenClaudeTasks(sessionId: string): Promise<ClaudeTaskEntry[]> {
  if (!sessionId) return [];

  const dir = path.join(tasksRootDir(), sessionId);
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }

  const open: ClaudeTaskEntry[] = [];
  for (const file of files) {
    if (!/^\d+\.json$/.test(file)) continue;
    const filePath = path.join(dir, file);
    try {
      const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
      const status = parsed?.status;
      if (status !== 'pending' && status !== 'in_progress') continue;
      const updatedAt = await fs.stat(filePath).then((s) => s.mtimeMs).catch(() => null);
      open.push({
        id: String(parsed.id ?? file.replace(/\.json$/, '')),
        subject: typeof parsed.subject === 'string' && parsed.subject ? parsed.subject : '(untitled)',
        status,
        waitingOnUser: Boolean(parsed.metadata?.waitingOnUser),
        updatedAt,
      });
    } catch {
      // Mid-rewrite or foreign content — skip rather than guess.
    }
  }

  open.sort((a, b) => Number(a.id) - Number(b.id));
  return open;
}
