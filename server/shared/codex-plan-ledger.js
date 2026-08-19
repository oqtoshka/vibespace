import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Reader for Codex's plan ledger. Codex has no per-task store on disk: the
 * plan lives in the session's rollout transcript as `update_plan` tool calls,
 * and every call carries the WHOLE plan — so the newest call is the current
 * state and no history needs replaying. Same read Mission Control's
 * codex-plan adapter performs.
 *
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<session-id>.jsonl
 *
 * One JSON object per line. The record wanted:
 *   { "type": "response_item",
 *     "payload": { "type": "function_call", "name": "update_plan",
 *                  "arguments": "{\"plan\":[{\"step\":\"…\",\"status\":\"pending\"}]}" } }
 * `arguments` is a JSON *string*. Code-mode encodes the same call as
 * `custom_tool_call` with the payload under `input`; both are accepted.
 */

// A plan set at the start of a long session can sit megabytes behind the end
// of the rollout; read a generous tail first and fall back to the whole file
// only when the tail shows no plan at all.
const TAIL_BYTES = 512 * 1024;

function codexSessionsRoot() {
  const home = process.env.CODEX_HOME?.trim();
  return path.join(home || path.join(os.homedir(), '.codex'), 'sessions');
}

/** Newest-first walk of sessions/YYYY/MM/DD for the session's rollout file. */
export function findCodexRolloutPath(sessionId, root = codexSessionsRoot()) {
  if (!sessionId) return null;
  const suffix = `-${sessionId}.jsonl`;
  const listDesc = (dir) => {
    try {
      return fsSync.readdirSync(dir).sort().reverse();
    } catch {
      return [];
    }
  };
  for (const year of listDesc(root)) {
    for (const month of listDesc(path.join(root, year))) {
      for (const day of listDesc(path.join(root, year, month))) {
        const dir = path.join(root, year, month, day);
        for (const file of listDesc(dir)) {
          if (file.endsWith(suffix)) return path.join(dir, file);
        }
      }
    }
  }
  return null;
}

/** Scan lines backwards for the newest parseable update_plan call. */
function findLatestPlan(text) {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    // Cheap reject before the expensive parse: most lines are not plan calls.
    if (!line.includes('update_plan')) continue;
    try {
      const payload = JSON.parse(line)?.payload;
      if (!payload || payload.name !== 'update_plan') continue;
      // `arguments` on a function_call, `input` on a code-mode custom_tool_call.
      const raw = payload.arguments ?? payload.input;
      if (typeof raw !== 'string') continue;
      const plan = JSON.parse(raw)?.plan;
      if (Array.isArray(plan)) return plan;
    } catch {
      // A truncated or unexpected line. Keep looking further back — one bad
      // record must not hide an older good plan.
    }
  }
  return null;
}

function countToolCalls(text) {
  return (text.match(/"type":"(?:function_call|custom_tool_call)"/g) || []).length;
}

/**
 * The session's open plan steps plus an activity proxy for stall detection.
 * `activity` counts tool-call records in the scanned window — approximate
 * (the window slides), but between two nudges "unchanged" reliably means the
 * model ran no tools.
 */
export function readCodexPlanState(sessionId, root = codexSessionsRoot()) {
  const empty = { open: [], activity: 0 };
  const rolloutPath = findCodexRolloutPath(sessionId, root);
  if (!rolloutPath) return empty;

  let text;
  try {
    const size = fsSync.statSync(rolloutPath).size;
    if (size > TAIL_BYTES) {
      const fd = fsSync.openSync(rolloutPath, 'r');
      try {
        const buffer = Buffer.alloc(TAIL_BYTES);
        fsSync.readSync(fd, buffer, 0, TAIL_BYTES, size - TAIL_BYTES);
        text = buffer.toString('utf8');
      } finally {
        fsSync.closeSync(fd);
      }
      // A plan set once at the start and never revised is still the current
      // plan — worth one expensive read before reporting "no tasks".
      if (!findLatestPlan(text)) {
        text = fsSync.readFileSync(rolloutPath, 'utf8');
      }
    } else {
      text = fsSync.readFileSync(rolloutPath, 'utf8');
    }
  } catch {
    return empty;
  }

  const plan = findLatestPlan(text);
  if (!plan) return empty;

  const open = [];
  plan.forEach((step, index) => {
    const status = step?.status;
    if (status !== 'pending' && status !== 'in_progress') return;
    open.push({
      id: String(index + 1),
      subject: typeof step.step === 'string' && step.step ? step.step : '(untitled)',
      status,
    });
  });
  return { open, activity: countToolCalls(text) };
}
