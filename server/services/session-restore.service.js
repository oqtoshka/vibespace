/**
 * Restore-on-boot for agent sessions.
 *
 * Provider runtimes register every live (non-ephemeral) session here; the
 * registry is mirrored to <dataDir>/active-agent-sessions.json so
 * it survives the process. A clean teardown (idle reap, user abort, ephemeral
 * completion) removes its entry, so whatever is still in the file when the
 * server boots is work a restart or crash orphaned — each such session gets a
 * [session supervisor] continuation turn, the same shape the task-nudge
 * mechanism injects, provided it still looks worth resuming (an in-flight
 * turn at shutdown, or open items in its native task ledger).
 *
 * VIBESPACE_SESSION_RESTORE=0 disables the boot pass (recording always runs —
 * it is what makes the next boot able to decide).
 */
import { promises as fs } from 'fs';
import path from 'path';

import { readOpenClaudeTasks } from '../shared/claude-task-ledger.js';
import { readCodexPlanState } from '../shared/codex-plan-ledger.js';
import { getDataDir } from '../utils/worktrees.js';

import { isRateLimitWakePending, loadRateLimitWakes } from './rate-limit-wake.service.js';

const RESTORE_ENABLED = !['0', 'false', 'off'].includes((process.env.VIBESPACE_SESSION_RESTORE || '').trim().toLowerCase());
// Entries older than this are stale leftovers (e.g. the file survived weeks of
// the feature being disabled) — skip them rather than waking ancient sessions.
const RESTORE_MAX_AGE_MS = parseInt(process.env.VIBESPACE_SESSION_RESTORE_MAX_AGE_MS, 10) || 24 * 60 * 60 * 1000;

const CONTINUATION_PROMPT = [
  '[session supervisor] The vibespace server was restarted while this session was',
  'active, and any turn that was running was cut off (an unexplained "[Request',
  'interrupted by user]" in the transcript is that restart, not the user). Review',
  'your task ledger and the tail of your previous work, then continue where you',
  'left off. Update task statuses as you go; finish or explicitly re-scope every',
  'open task.',
].join(' ');

const stateFile = () => path.join(getDataDir(), 'active-agent-sessions.json');
// Read-only migration source. Deployments that already have Claude restore
// state must not lose it when the registry becomes provider-neutral.
const legacyStateFile = () => path.join(getDataDir(), 'active-claude-sessions.json');

// In-memory mirror of the file; sessionId -> entry.
const entries = new Map();
let loaded = false;
let writeTimer = null;

async function loadOnce() {
  if (loaded) return;
  loaded = true;
  let raw = null;
  try {
    raw = JSON.parse(await fs.readFile(stateFile(), 'utf8'));
  } catch {
    try {
      raw = JSON.parse(await fs.readFile(legacyStateFile(), 'utf8'));
    } catch { /* first run or unreadable — start empty */ }
  }
  for (const e of Array.isArray(raw) ? raw : []) {
    if (e && typeof e.sessionId === 'string') {
      entries.set(e.sessionId, { ...e, provider: e.provider || 'claude' });
    }
  }
}

/** Debounced atomic mirror of the registry to disk. */
function scheduleWrite() {
  if (writeTimer) return;
  writeTimer = setTimeout(async () => {
    writeTimer = null;
    const file = stateFile();
    const tmp = `${file}.tmp`;
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(tmp, JSON.stringify([...entries.values()], null, 2));
      await fs.rename(tmp, file);
    } catch (error) {
      console.warn('[session restore] failed to persist registry:', error?.message || error);
    }
  }, 500);
  writeTimer.unref?.();
}

/** Upsert a live session. Call on register and on turn start/end. */
export async function recordSessionActivity({ provider, sessionId, cwd, permissionMode, userId, turnActive, private: isPrivate }) {
  if (!sessionId) return;
  await loadOnce();
  const prev = entries.get(sessionId) || {};
  entries.set(sessionId, {
    provider: provider ?? prev.provider ?? 'claude',
    sessionId,
    cwd: cwd ?? prev.cwd,
    permissionMode: permissionMode ?? prev.permissionMode,
    userId: userId ?? prev.userId,
    // Sticky once set: a private session must come back private. Nothing can
    // clear it short of the session ending.
    private: Boolean(isPrivate ?? prev.private),
    turnActive: Boolean(turnActive),
    // Owned by recordPendingInteraction — activity updates must not drop it.
    pendingPrompt: prev.pendingPrompt ?? null,
    updatedAt: Date.now(),
  });
  scheduleWrite();
}

/**
 * Marks (or clears, with `prompt = null`) the interactive prompt a session's
 * turn is currently parked on — AskUserQuestion, plan approval. Cleared
 * whenever the wait settles in-process; a hard kill leaves it set, so the boot
 * pass knows the user never saw the question and tells the resumed agent to
 * re-ask it (the transcript alone records it as an ordinary interrupted tool
 * call, which reads as the user declining — it wasn't).
 */
export async function recordPendingInteraction(sessionId, prompt) {
  if (!sessionId) return;
  await loadOnce();
  const entry = entries.get(sessionId);
  if (!entry) return;
  entry.pendingPrompt = prompt
    ? { toolName: prompt.toolName, input: prompt.input, askedAt: Date.now() }
    : null;
  scheduleWrite();
}

/** Drop a session that ended cleanly — it must not be restored on boot. */
export async function recordSessionEnd(sessionId) {
  if (!sessionId) return;
  await loadOnce();
  if (entries.delete(sessionId)) scheduleWrite();
}

/**
 * Removes a session's registry entry for good — the shred path.
 *
 * Unlike `recordSessionEnd`, which only has to stop the next boot from
 * resuming the session, this one has to make the entry disappear from the
 * file on disk now, so it flushes the mirror instead of debouncing it.
 * Returns whether an entry was there to remove.
 */
export async function forgetSession(sessionId) {
  if (!sessionId) return false;
  await loadOnce();
  const had = entries.delete(sessionId);
  if (!had) return false;
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  const file = stateFile();
  const tmp = `${file}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify([...entries.values()], null, 2));
  await fs.rename(tmp, file);
  return true;
}

/** The supervisor prompt for one entry, with the re-ask rider when a hard
 * kill destroyed an interactive prompt the user never answered. */
function buildContinuationPrompt(entry) {
  const pending = entry.pendingPrompt;
  if (!pending?.toolName) return CONTINUATION_PROMPT;
  let inputJson = '';
  try {
    inputJson = JSON.stringify(pending.input) || '';
  } catch { /* unserializable — reconstruct from transcript */ }
  if (inputJson.length > 8000) inputJson = '';
  return `${CONTINUATION_PROMPT} IMPORTANT: that turn was parked on an interactive ${pending.toolName} `
    + 'prompt that the user never saw or answered — the restart destroyed it, and the transcript may '
    + 'record it as skipped, denied, or interrupted (that was NOT the user declining). Before anything '
    + `else, ask it again with a fresh ${pending.toolName} call`
    + (inputJson ? `, preserving the original content: ${inputJson}` : ', reconstructed from the transcript.');
}

/**
 * Boot pass: resume every recorded session that still has work. `spawn` is
 * queryClaudeSDK (injected to avoid a module cycle). `hooks.startTurn(entry,
 * prompt)`, when provided, is tried first: it lets the entrypoint start the
 * turn as a real chat-run (registered in the run registry, so a client that
 * opens the session sees it processing and receives any interactive prompt it
 * parks on); it must kick the turn off WITHOUT awaiting it and return true.
 * Falsy/throw falls back to a detached spawn. Returns the session ids resumed,
 * mostly for logging and tests.
 */
let bootPassDone = false;

export async function restoreInterruptedSessions(spawn, hooks = {}) {
  await loadOnce();
  // Both entrypoints arm the pass (the CLI wrapper and claude-sdk's module
  // hook, for deployments that launch index.js directly) — run it once.
  if (bootPassDone) return [];
  bootPassDone = true;
  if (!RESTORE_ENABLED) return [];
  await loadRateLimitWakes();
  const candidates = [...entries.values()];
  const resumed = [];
  for (const entry of candidates) {
    const age = Date.now() - (entry.updatedAt || 0);
    if (age > RESTORE_MAX_AGE_MS) {
      entries.delete(entry.sessionId);
      continue;
    }
    if (isRateLimitWakePending(entry.sessionId)) {
      // Parked on a usage limit: resuming now would just hit it again. The
      // wake service owns this session and resumes it after the reset.
      console.log(`[session restore] ${entry.sessionId} is waiting for a usage-limit reset — leaving it to the wake scheduler`);
      entries.delete(entry.sessionId);
      continue;
    }
    if (!entry.cwd) {
      // No working directory means this is not a real workspace session (a
      // test harness, a half-written entry) — resuming it would spawn a CLI in
      // whatever directory the server happens to be running from.
      entries.delete(entry.sessionId);
      continue;
    }
    let openTasks = [];
    try {
      openTasks = entry.provider === 'codex'
        ? readCodexPlanState(entry.sessionId).open
        : await readOpenClaudeTasks(entry.sessionId);
    } catch { /* unreadable ledger counts as empty */ }
    if (!entry.turnActive && openTasks.length === 0) {
      // It was idling with nothing declared — the reaper would have ended it
      // anyway; don't wake it just to say "continue".
      entries.delete(entry.sessionId);
      continue;
    }
    if (!entry.turnActive && openTasks.every((t) => t.waitingOnUser)) {
      // Every open task is parked on the user (marked waitingOnUser by the
      // model). Waking the session to "continue" would only pressure it into
      // closing work the user never signed off on; the tasks stay open on
      // disk, so a supervisor board keeps showing them, and the user's next
      // message resumes the session the ordinary way.
      console.log(`[session restore] ${entry.sessionId} is waiting on the user (${openTasks.length} parked task(s)) — not resuming`);
      entries.delete(entry.sessionId);
      continue;
    }
    const prompt = buildContinuationPrompt(entry);
    const hadPendingPrompt = Boolean(entry.pendingPrompt);
    // Consumed: the re-ask rider is in this resume's prompt now, and the fresh
    // interactive call (if any) re-records itself.
    entry.pendingPrompt = null;
    console.log(`[session restore] resuming ${entry.sessionId} (turnActive=${entry.turnActive}, openTasks=${openTasks.length}, pendingPrompt=${hadPendingPrompt})`);
    // Fire-and-forget: the spawn's promise resolves only when the whole first
    // turn completes, and awaiting it here would queue every other session
    // behind one long-running resume. The spawn re-registers the session,
    // refreshing its registry entry.
    let started = false;
    if (typeof hooks.startTurn === 'function') {
      try {
        started = Boolean(await hooks.startTurn(entry, prompt));
      } catch (error) {
        console.warn(`[session restore] run-based resume of ${entry.sessionId} failed, falling back to detached:`, error?.message || error);
      }
    }
    if (!started) {
      const detachedSpawn = typeof spawn === 'function' ? spawn : spawn?.[entry.provider || 'claude'];
      if (typeof detachedSpawn !== 'function') {
        console.warn(`[session restore] no ${entry.provider || 'claude'} starter for ${entry.sessionId}; leaving it for the next boot`);
        continue;
      }
      detachedSpawn(prompt, {
        sessionId: entry.sessionId,
        resume: true,
        cwd: entry.cwd,
        permissionMode: entry.permissionMode,
        private: Boolean(entry.private),
      }, makeDetachedWriter(entry.userId)).catch((error) => {
        console.error(`[session restore] resume of ${entry.sessionId} failed:`, error?.message || error);
      });
      started = true;
    }
    if (!started) continue;
    resumed.push(entry.sessionId);
    // Small stagger so a fleet of resumes doesn't spawn CLIs all at once.
    await new Promise((r) => setTimeout(r, 2000));
  }
  scheduleWrite();
  if (resumed.length === 0) console.log('[session restore] nothing to resume');
  return resumed;
}

/**
 * A writer for sessions resumed with no client attached: swallows messages
 * (the transcript file is the durable record) but keeps the userId so
 * notifications and per-user bookkeeping still resolve.
 */
function makeDetachedWriter(userId) {
  return { userId: userId || null, send() { /* no client yet */ }, readyState: 1 };
}

/** Test seam: reset module state between cases. */
export function __resetSessionRestoreState() {
  entries.clear();
  loaded = false;
  bootPassDone = false;
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
}
