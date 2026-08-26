import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Reader for Codex's plan ledger. Codex has no per-task store on disk: the
 * plan lives in the session's rollout transcript as `update_plan` tool calls,
 * and every call carries the WHOLE plan — so the newest call is the current
 * state and no history needs replaying. Same read a supervisor board's
 * codex-plan adapter performs.
 *
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<session-id>.jsonl
 *
 * One JSON object per line. The record wanted:
 *   { "type": "response_item",
 *     "payload": { "type": "function_call", "name": "update_plan",
 *                  "arguments": "{\"plan\":[{\"step\":\"…\",\"status\":\"pending\"}]}" } }
 * `arguments` is a JSON *string*. Older code-mode builds encoded the same call
 * as a `custom_tool_call` named `update_plan`. Current code mode wraps tools in
 * an `exec` call whose input contains `tools.update_plan({...})`; all three
 * forms are accepted.
 */

// A plan set at the start of a long session can sit megabytes behind the end
// of the rollout; read a generous tail first and fall back to the whole file
// only when the tail shows no plan at all.
const TAIL_BYTES = 512 * 1024;

/**
 * Extract the object literal passed to `tools.update_plan(...)` without
 * evaluating transcript contents. Code mode emits JSON-compatible strings but
 * leaves JavaScript object keys unquoted, so quote only bare keys while outside
 * strings and then hand the result to JSON.parse.
 */
function extractWrappedPlanArguments(source) {
  const marker = 'tools.update_plan';
  const markerIndex = source.lastIndexOf(marker);
  if (markerIndex < 0) return null;

  const callStart = source.indexOf('(', markerIndex + marker.length);
  if (callStart < 0) return null;

  let objectStart = callStart + 1;
  while (/\s/.test(source[objectStart] || '')) objectStart += 1;
  if (source[objectStart] !== '{') return null;

  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let i = objectStart; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{' || char === '[') depth += 1;
    if (char === '}' || char === ']') depth -= 1;
    if (depth === 0) {
      return source.slice(objectStart, i + 1);
    }
  }
  return null;
}

function jsonFromCodeModeObject(source) {
  let result = '';
  let quote = null;
  let escaped = false;

  for (let i = 0; i < source.length;) {
    const char = source[i];
    if (quote) {
      result += char;
      i += 1;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"') {
      quote = char;
      result += char;
      i += 1;
      continue;
    }

    if (/[A-Za-z_$]/.test(char)) {
      let end = i + 1;
      while (/[A-Za-z0-9_$]/.test(source[end] || '')) end += 1;
      const identifier = source.slice(i, end);
      const previous = result.trimEnd().at(-1);
      let next = end;
      while (/\s/.test(source[next] || '')) next += 1;
      result += (previous === '{' || previous === ',') && source[next] === ':'
        ? JSON.stringify(identifier)
        : identifier;
      i = end;
      continue;
    }

    // Trailing commas are valid in the generated JavaScript but not JSON.
    if (char === ',') {
      let next = i + 1;
      while (/\s/.test(source[next] || '')) next += 1;
      if (source[next] === '}' || source[next] === ']') {
        i += 1;
        continue;
      }
    }

    result += char;
    i += 1;
  }

  return result;
}

function planFromPayload(payload) {
  let raw = null;
  if (payload?.name === 'update_plan') {
    raw = payload.arguments ?? payload.input;
  } else if (payload?.type === 'custom_tool_call' && payload.name === 'exec') {
    raw = extractWrappedPlanArguments(payload.input || '');
    if (raw) raw = jsonFromCodeModeObject(raw);
  }
  if (typeof raw !== 'string') return null;
  const plan = JSON.parse(raw)?.plan;
  return Array.isArray(plan) ? plan : null;
}

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
      const plan = planFromPayload(JSON.parse(line)?.payload);
      if (plan) return plan;
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
