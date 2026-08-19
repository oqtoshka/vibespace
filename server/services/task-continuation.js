import { readCodexPlanState } from '../shared/codex-plan-ledger.js';
import { readOpenCodeTaskState } from '../shared/opencode-todo-ledger.js';

import { notifyRunFailed } from './notification-orchestrator.js';

/**
 * Task-ledger continuation for the per-turn providers (OpenCode, Codex).
 *
 * The Claude runner keeps a persistent subprocess, so its equivalent lives in
 * claude-sdk.js as an idle-reaper gate. OpenCode and Codex run one process per
 * turn — there is no reaper to gate — so the same promise is kept at the turn
 * boundary instead: a turn that ends while the model's own ledger (OpenCode's
 * todo table, Codex's update_plan) still has open items gets a continuation
 * turn, and the model exits the loop by editing the ledger.
 *
 * Bounds mirror the Claude mechanism: at most TASK_NUDGE_MAX continuations per
 * session, and two consecutive nudges that run no tools and leave the ledger
 * untouched give up early — both bail-outs notify through the ordinary
 * run-failed channel. VIBESPACE_TASK_NUDGE=0 disables the mechanism.
 */

const TASK_NUDGE_MAX = parseInt(process.env.VIBESPACE_TASK_NUDGE_MAX, 10) || 5;
const TASK_NUDGE_ENABLED = !['0', 'false', 'off'].includes((process.env.VIBESPACE_TASK_NUDGE || '').trim().toLowerCase());

const LEDGERS = {
  opencode: { read: readOpenCodeTaskState, listName: 'todo list', closeHow: 'todowrite' },
  codex: { read: readCodexPlanState, listName: 'plan', closeHow: 'update_plan' },
};

// `${provider}:${sessionId}` -> { count, stalls, fingerprint, activity }.
// Entries are dropped as soon as a session's ledger closes or a bail-out
// fires, so the map only ever holds sessions mid-continuation.
const states = new Map();

function buildOpenTasksNudge(open, { listName, closeHow }) {
  return [
    `[session supervisor] Automated check: this turn ended, but your ${listName} still has open items:`,
    ...open.map((t) => `- #${t.id} [${t.status}] ${t.subject}`),
    '',
    'Continue working through them now. If an item is no longer relevant or cannot proceed, '
      + `close it explicitly via ${closeHow} — mark it completed or replace it with a re-scoped item — `
      + 'and say why. Do not stop while items remain open.',
  ].join('\n');
}

/**
 * Decides whether a just-finished turn should roll into a continuation turn.
 * Returns the continuation prompt, or null when the session is genuinely done
 * (no open items), the mechanism is off, or nudging has stopped helping — the
 * give-up paths notify the user before returning null.
 */
export function planTaskContinuation({ provider, sessionId, userId = null, sessionName = null }) {
  const ledger = LEDGERS[provider];
  if (!TASK_NUDGE_ENABLED || !ledger || !sessionId) return null;

  const { open, activity } = ledger.read(sessionId);
  const key = `${provider}:${sessionId}`;
  if (open.length === 0) {
    states.delete(key);
    return null;
  }

  const state = states.get(key) || { count: 0, stalls: 0, fingerprint: null, activity: 0 };
  const fingerprint = open.map((t) => `${t.id}:${t.status}`).join(',');
  if (state.count > 0 && fingerprint === state.fingerprint && activity === state.activity) {
    state.stalls += 1;
  } else {
    state.stalls = 0;
  }

  if (state.count >= TASK_NUDGE_MAX || state.stalls >= 2) {
    const subjects = open.map((t) => t.subject).join('; ');
    const why = state.stalls >= 2 ? 'no progress across two nudges' : `nudge budget (${TASK_NUDGE_MAX}) exhausted`;
    console.log(`[${provider} tasks] session ${sessionId}: giving up (${why}) with ${open.length} open task(s): ${subjects}`);
    notifyRunFailed({
      userId,
      provider,
      sessionId,
      sessionName,
      error: `Turn ended with ${open.length} open task(s) — ${why}: ${subjects}`,
    });
    states.delete(key);
    return null;
  }

  state.count += 1;
  state.fingerprint = fingerprint;
  state.activity = activity;
  states.set(key, state);
  console.log(`[${provider} tasks] session ${sessionId}: turn ended with ${open.length} open task(s) — continuing (${state.count}/${TASK_NUDGE_MAX})`);
  return buildOpenTasksNudge(open, ledger);
}

/** Test seams. */
export function __clearTaskContinuationState() {
  states.clear();
}

const defaultReaders = { opencode: LEDGERS.opencode.read, codex: LEDGERS.codex.read };
export function __setTaskLedgerReader(provider, read) {
  LEDGERS[provider].read = read || defaultReaders[provider];
}
