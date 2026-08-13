/**
 * Background session titles and recaps.
 *
 * Two different jobs the UI needs and the transcript cannot answer on its own:
 *
 * - a TITLE — a few words, what the lists show. The mechanical fallback was the
 *   last prompt the user typed, which reads as a fragment of a sentence rather
 *   than a label ("also i want you to change how our By activity tab works").
 * - a RECAP — a sentence or two on what the session is actually doing, shown in
 *   the session pane header, and kept current as the conversation moves.
 *
 * Both come from one cheap model call over the tail of the transcript.
 *
 * DEBOUNCED, NOT PER-TURN. A run is often a burst of short turns; summarising
 * each one would spend a call per turn to describe a conversation that has
 * barely moved. Scheduling restarts the timer, so a burst costs one call once
 * the session goes quiet. The transcript size the last recap described is
 * recorded, so an idle session is never re-summarised for nothing.
 *
 * BEST EFFORT THROUGHOUT. Every failure path is a warning: a session without a
 * recap shows its title, which is what it did before this existed. Nothing here
 * may fail a turn or block one — the generation runs after the turn is over and
 * its result is delivered whenever it arrives.
 */

import { promises as fs } from 'fs';

import { sessionsDb } from '../modules/database/repositories/sessions.db.js';
import { sessionsService } from '../modules/providers/services/sessions.service.js';

/**
 * Quiet period before summarising. Long enough that a normal back-and-forth
 * settles into one call, short enough that the header is current by the time
 * the user looks away and back.
 */
const RECAP_DEBOUNCE_MS = parseInt(process.env.VS_RECAP_DEBOUNCE_MS, 10) || 15000;

/** Transcript lines fed to the model — the tail is what the recap is about. */
const RECAP_TRANSCRIPT_LINES = 40;

/** Per-message cap, so one pasted file cannot crowd out the conversation. */
const RECAP_MESSAGE_CHARS = 600;

/** Total prompt cap, a backstop for the per-message cap. */
const RECAP_PROMPT_CHARS = 12000;

/** Hard caps on what we will store, mirroring the prompt's instructions. */
const MAX_TITLE_CHARS = 60;
const MAX_RECAP_CHARS = 400;

/**
 * Model for the summarising call when the caller names none — Claude's cheap
 * tier, because this runs once per session. Providers without a cheap tier of
 * their own pass the session's current model instead, which is the only one
 * they are certain can serve the request at all.
 */
const DEFAULT_RECAP_MODEL = 'haiku';

/** sessionId -> pending debounce timer. */
const pendingRecaps = new Map();

/** sessionId -> true while a generation is in flight, so bursts don't stack. */
const inFlightRecaps = new Set();

/**
 * Pulls the readable tail out of a Claude JSONL transcript.
 *
 * Tool calls and their results are deliberately dropped: they are most of the
 * bytes and almost none of the meaning, and a recap built from them describes
 * the plumbing rather than the work. What is left is the user's asks and the
 * assistant's prose, which is what a recap is a summary of.
 *
 * @param {string} jsonlPath
 * @returns {Promise<{messages: Array<{role: string, text: string}>, total: number}>}
 */
async function readTranscriptTail(jsonlPath) {
  let content;
  try {
    content = await fs.readFile(jsonlPath, 'utf8');
  } catch {
    return { messages: [], total: 0 };
  }

  const messages = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (entry.type !== 'user' && entry.type !== 'assistant') continue;

    const rawContent = entry.message?.content;
    const blocks = Array.isArray(rawContent)
      ? rawContent
      : typeof rawContent === 'string'
        ? [{ type: 'text', text: rawContent }]
        : [];

    const text = blocks
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim();

    if (!text) continue;

    // Local commands and system reminders are host chatter, not conversation.
    if (text.startsWith('<local-command') || text.startsWith('<system-reminder')) continue;

    messages.push({
      role: entry.type,
      text: text.length > RECAP_MESSAGE_CHARS ? `${text.slice(0, RECAP_MESSAGE_CHARS)}…` : text,
    });
  }

  // `total` is the whole conversation, not the tail: it is what tells an idle
  // session apart from one that has moved on. Comparing tail lengths would
  // stop every session dead at RECAP_TRANSCRIPT_LINES, since past that point
  // the tail is always exactly that long and no recap would ever refresh.
  return { messages: messages.slice(-RECAP_TRANSCRIPT_LINES), total: messages.length };
}

/**
 * The same tail, for a provider that keeps no transcript file.
 *
 * OpenCode stores conversations in one shared SQLite database rather than a
 * file per session, so there is nothing to read line by line. Its history
 * reader already returns the normalized messages the UI renders, which is the
 * same material `readTranscriptTail` extracts from a JSONL — tool calls and
 * their results excluded, since they are most of the bytes and almost none of
 * the meaning.
 *
 * @param {string} sessionId - App session id.
 * @param {Function} [fetchHistory] - Test seam; defaults to the session service.
 * @returns {Promise<{messages: Array<{role: string, text: string}>, total: number}>}
 */
async function readIndexedTranscriptTail(
  sessionId,
  fetchHistory = (id, options) => sessionsService.fetchHistory(id, options),
) {
  let history;
  try {
    // A generous multiple of the line budget: the page is counted in messages
    // of every kind, and only the text ones survive the filter below.
    history = await fetchHistory(sessionId, { limit: RECAP_TRANSCRIPT_LINES * 4, offset: 0 });
  } catch {
    return { messages: [], total: 0 };
  }

  const messages = [];
  for (const message of history.messages ?? []) {
    if (message?.kind !== 'text') continue;

    const text = typeof message.content === 'string' ? message.content.trim() : '';
    if (!text) continue;
    if (text.startsWith('<local-command') || text.startsWith('<system-reminder')) continue;

    messages.push({
      role: message.role === 'user' ? 'user' : 'assistant',
      text: text.length > RECAP_MESSAGE_CHARS ? `${text.slice(0, RECAP_MESSAGE_CHARS)}…` : text,
    });
  }

  // `total` counts every message in the session, not just the readable ones on
  // this page — an approximation, but a monotonic one, which is all the
  // idle-session check needs.
  return {
    messages: messages.slice(-RECAP_TRANSCRIPT_LINES),
    total: Math.max(history.total ?? 0, messages.length),
  };
}

function buildRecapPrompt(messages) {
  const transcript = messages
    .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.text}`)
    .join('\n\n')
    .slice(-RECAP_PROMPT_CHARS);

  return [
    'Below is the tail of a coding session between a user and an AI assistant.',
    '',
    'Reply with ONLY a JSON object, no prose and no code fence:',
    '',
    '{"title": "...", "recap": "..."}',
    '',
    `- "title": 2-4 words naming what this session is about, like a tab label.`,
    '  Title Case, no trailing punctuation, no quotes. Name the subject, not the',
    '  activity: "Dind Image Pruning", not "Fixing A Bug".',
    `- "recap": 1-2 sentences (max ${MAX_RECAP_CHARS} characters) on what the`,
    '  session is doing and where it currently stands. Write it for someone',
    '  returning to this session after a break. Plain past/present tense, no',
    '  preamble like "This session".',
    '',
    'Describe the whole session, weighted towards the most recent exchanges.',
    '',
    '--- TRANSCRIPT ---',
    transcript,
    '--- END TRANSCRIPT ---',
  ].join('\n');
}

/**
 * Pulls the JSON object out of a model reply.
 *
 * Small models sometimes wrap it in a fence or a sentence even when told not
 * to, and re-running costs another call, so accept the object wherever it is.
 */
function parseRecapResponse(text) {
  if (typeof text !== 'string' || !text.trim()) return null;

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }

  const title = typeof parsed.title === 'string' ? parsed.title.trim() : '';
  const recap = typeof parsed.recap === 'string' ? parsed.recap.trim() : '';
  if (!title && !recap) return null;

  return {
    title: title.slice(0, MAX_TITLE_CHARS),
    recap: recap.slice(0, MAX_RECAP_CHARS),
  };
}

/**
 * Runs the summarising call and stores the result.
 *
 * @param {Object} params
 * @param {string} params.sessionId - Runtime session id (app or provider id).
 * @param {string} params.cwd - Project root; the helper session runs here.
 * @param {Function} params.runQuery - The provider's own query entry point,
 *   injected to keep this module free of a cycle back into the runtime layer.
 * @param {string} [params.model] - Model for the summarising call. Defaults to
 *   Claude's cheap tier; other providers pass what they can actually run.
 * @param {Function} [params.onRecap] - Called with the stored result so the
 *   caller can push it to connected clients.
 */
async function generateRecap({ sessionId, cwd, runQuery, model, onRecap }) {
  const session = sessionsDb.getSessionById(sessionId)
    ?? sessionsDb.getSessionByProviderSessionId(sessionId);
  if (!session) return;

  // A transcript file when the provider keeps one per session, the indexed
  // history when it keeps a shared store instead (OpenCode).
  const { messages, total } = session.jsonl_path
    ? await readTranscriptTail(session.jsonl_path)
    : await readIndexedTranscriptTail(session.session_id);
  // One exchange is not yet a session worth describing.
  if (messages.length < 2) return;

  // Nothing new since the last recap — the debounce fired on an idle session.
  if (session.recap && session.recap_message_count === total) return;

  let responseText = '';
  const writer = {
    // The helper run has no user behind it, so nothing it does may raise a
    // notification.
    userId: null,
    send: (data) => {
      try {
        const parsed = typeof data === 'string' ? JSON.parse(data) : data;
        // Whole assistant messages (Claude) and streamed fragments (OpenCode)
        // are the same text arriving under two kinds; no runtime emits both
        // for the same content, so accumulating both cannot double-count.
        if ((parsed?.kind === 'text' || parsed?.kind === 'stream_delta')
          && typeof parsed.content === 'string') {
          responseText += parsed.content;
        }
      } catch {
        // A frame we cannot read is a frame we do not need.
      }
    },
    setSessionId: () => {},
  };

  await runQuery(buildRecapPrompt(messages), {
    cwd,
    model: model || DEFAULT_RECAP_MODEL,
    permissionMode: 'bypassPermissions',
    // Nothing to do but read the text it was handed.
    toolsSettings: { disallowedTools: ['Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task'] },
    ephemeral: true,
  }, writer);

  const result = parseRecapResponse(responseText);
  if (!result) {
    console.warn(`[recap] ${sessionId}: unparseable reply, keeping previous recap`);
    return;
  }

  // The app session id is the row key; the runtime may know the session by its
  // provider id, so resolve back to the row we actually read.
  const rowId = session.session_id;

  if (result.recap) {
    sessionsDb.updateSessionRecap(rowId, result.recap, total);
  }
  // 'ai' never overwrites a name the user set by hand — that ranking lives in
  // shouldReplaceSessionName and updateSessionCustomName honours it via
  // name_source, so a manual rename survives every later regeneration.
  if (result.title && session.name_source !== 'user') {
    sessionsDb.updateSessionCustomName(rowId, result.title, 'ai');
  }

  onRecap?.({
    sessionId: rowId,
    title: result.title || null,
    recap: result.recap || null,
  });
}

/**
 * Queues a recap for a session that has just finished a turn.
 *
 * Restarts the quiet period on each call, so a burst of turns produces one
 * call once the burst ends. Safe to call on every turn completion.
 *
 * @param {Object} params - See {@link generateRecap}.
 */
export function scheduleSessionRecap({ sessionId, cwd, runQuery, model, onRecap }) {
  if (!sessionId || !cwd || typeof runQuery !== 'function') return;

  const existing = pendingRecaps.get(sessionId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    pendingRecaps.delete(sessionId);
    // A generation already running will not see the newest turns, but the turn
    // that arrived during it schedules another pass, so nothing is lost.
    if (inFlightRecaps.has(sessionId)) return;

    inFlightRecaps.add(sessionId);
    generateRecap({ sessionId, cwd, runQuery, model, onRecap })
      .catch((error) => {
        console.warn(`[recap] ${sessionId} failed:`, error?.message || error);
      })
      .finally(() => {
        inFlightRecaps.delete(sessionId);
      });
  }, RECAP_DEBOUNCE_MS);

  // Node keeps the process alive for pending timers; a queued recap is not a
  // reason to hold a shutdown open.
  timer.unref?.();
  pendingRecaps.set(sessionId, timer);
}

/** Drops any queued recap for a session (ended, deleted). */
export function cancelSessionRecap(sessionId) {
  const existing = pendingRecaps.get(sessionId);
  if (existing) {
    clearTimeout(existing);
    pendingRecaps.delete(sessionId);
  }
}

/** Test seam. */
export const __testing = {
  readTranscriptTail,
  readIndexedTranscriptTail,
  parseRecapResponse,
  buildRecapPrompt,
};
