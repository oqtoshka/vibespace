/**
 * Shared notification-content helpers.
 *
 * Turns a session's last assistant message + tool activity into a compact,
 * *stateful* recap used by both delivery channels (web push and Telegram). Kept
 * provider-agnostic: callers pass `{ recap, toolNames }` in the event meta.
 *
 * NOTE: the Claude Code hook (~/.claude/hooks/telegram-notify.mjs) carries a
 * parallel copy of this logic because it can't import server modules — keep the
 * two roughly in sync.
 */

const MAX_RECAP = 320;
const MAX_CMD = 180;

const BACKGROUND_TOOLS = new Set(['Monitor', 'ScheduleWakeup', 'CronCreate']);

const STATE_PRESENTATION = {
  finished: { emoji: '✅', label: 'Finished' },
  question: { emoji: '❓', label: 'Needs your answer' },
  background: { emoji: '🛰️', label: 'Working in background' },
};

function clip(value, max) {
  const s = String(value);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Collapses a (possibly markdown) assistant message into one short line. */
function summarizeRecap(text) {
  if (!text || typeof text !== 'string') return '';
  const cleaned = text
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/^\s*[-*]\s+/gm, '• ');
  const paras = cleaned
    .split(/\n\s*\n/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  // The closing paragraph is usually the conclusion or the question.
  const s = paras.length ? paras[paras.length - 1] : cleaned.replace(/\s+/g, ' ').trim();
  return clip(s, MAX_RECAP);
}

function isQuestion(text) {
  const t = (text || '').trim();
  if (!t) return false;
  if (/\?\s*$/.test(t)) return true;
  const tail = t.slice(-240).toLowerCase();
  return /(let me know|which (one|would|approach|do)|should i\b|do you want|would you like|your call|up to you|how would you like|want me to)/i.test(
    tail,
  );
}

function isBackground(text, toolNames) {
  const ranBgTool = Array.isArray(toolNames) && toolNames.some((n) => BACKGROUND_TOOLS.has(n));
  const tail = (text || '').slice(-280).toLowerCase();
  const bgText =
    /(in the background|background (job|task|process|run|agent)|monitoring|watching for|i'?ll (check back|resume|be notified|wake|let you know when)|once (it|the|that|this|they).{0,40}(finish|complete|done|ready)|waiting (for|on) (it|the|ci|the build|the deploy|them)|polling)/i.test(
      tail,
    );
  return ranBgTool || bgText;
}

/**
 * Classifies a finished assistant turn. Returns { state, emoji, label }.
 * `state` is one of: question | background | finished.
 */
function classifyAssistantState({ recap = '', toolNames = [] } = {}) {
  let state = 'finished';
  if (isQuestion(recap)) state = 'question';
  else if (isBackground(recap, toolNames)) state = 'background';
  return { state, ...STATE_PRESENTATION[state] };
}

/** Human-readable summary of a pending tool call awaiting approval. */
function describeTool(name, input = {}) {
  if (!name) return '';
  switch (name) {
    case 'Bash':
      return input.command ? `$ ${clip(input.command, MAX_CMD)}` : 'a shell command';
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return input.file_path ? `edit ${clip(input.file_path, MAX_CMD)}` : 'a file edit';
    case 'Read':
      return input.file_path ? `read ${clip(input.file_path, MAX_CMD)}` : 'a file read';
    case 'WebFetch':
      return input.url ? `fetch ${clip(input.url, MAX_CMD)}` : 'a web fetch';
    case 'Agent':
    case 'Task':
      return `run agent${input.description ? ` (${clip(input.description, MAX_CMD)})` : ''}`;
    default:
      return name;
  }
}

export { summarizeRecap, classifyAssistantState, describeTool, BACKGROUND_TOOLS };
