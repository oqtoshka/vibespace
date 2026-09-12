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
 * barely moved. Scheduling coalesces progress without moving the deadline, so even
 * a long-running session receives a recap before its turn finishes. The transcript size the last recap described is
 * recorded, so an idle session is never re-summarised for nothing.
 *
 * BEST EFFORT THROUGHOUT. Every failure path is a warning: a session without a
 * recap shows its title, which is what it did before this existed. Nothing here
 * may fail a turn or block one — generation runs alongside the turn and
 * its result is delivered whenever it arrives.
 */

import { promises as fs } from 'fs';

import { sessionsDb } from '@/modules/database/index.js';
import type { AnyRecord, ProviderRunFunction } from '@/shared/index.js';

import { sessionsService } from './sessions.service.js';
import { readTopicMemory, topicBatch, topicInstructions, mergeTopicResponse } from './session-topics.service.js';

/**
 * Quiet period before summarising. Long enough that a normal back-and-forth
 * settles into one call, short enough that the header is current by the time
 * the user looks away and back.
 */
const RECAP_DEBOUNCE_MS = parseInt(process.env.VS_RECAP_DEBOUNCE_MS || '', 10) || 15000;

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

/** UI locales supported by the frontend, mapped to prompt-safe names. */
const RECAP_LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  fr: 'French',
  es: 'Spanish',
  ko: 'Korean',
  'zh-CN': 'Simplified Chinese',
  'zh-TW': 'Traditional Chinese',
  ja: 'Japanese',
  ru: 'Russian',
  de: 'German',
  tr: 'Turkish',
  it: 'Italian',
};

type RecapMessage = { role: string; text: string };
type RecapInput = {
  sessionId: string;
  cwd: string;
  runQuery: ProviderRunFunction;
  model?: string;
  fallbackModel?: string | null;
  onRecap?: (result: { sessionId: string; title: string | null; recap: string | null }) => void;
  useIndexedHistory?: boolean;
  fetchHistory?: (id: string, options: { limit: number; offset: number }) => Promise<{ messages: AnyRecord[]; total?: number }>;
  locale?: string;
};
/** Fixed deadlines and the latest inputs to include at each deadline. */
const pendingRecaps = new Map<string, ReturnType<typeof setTimeout>>();
const latestRecaps = new Map<string, RecapInput>();

/** sessionId -> true while a generation is in flight, so bursts don't stack. */
const inFlightRecaps = new Set<string>();
// Progress can arrive many times a minute. The first recap is quick; later
// refreshes are limited to one helper per minute, even during an active turn.
const nextRefreshAt = new Map<string, number>();

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
async function readTranscriptTail(jsonlPath: string) {
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
      .filter((block: AnyRecord) => block?.type === 'text' && typeof block.text === 'string')
      .map((block: AnyRecord) => block.text)
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
  sessionId: string,
  fetchHistory: NonNullable<RecapInput['fetchHistory']> = (id, options) => sessionsService.fetchHistory(id, options),
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

function resolveRecapLanguage(locale: string) {
  if (typeof locale !== 'string') return RECAP_LANGUAGE_NAMES.en;

  const exactLocale = Object.keys(RECAP_LANGUAGE_NAMES).find(
    (supportedLocale) => supportedLocale.toLowerCase() === locale.trim().toLowerCase(),
  );
  if (exactLocale) return RECAP_LANGUAGE_NAMES[exactLocale];

  const baseLocale = locale.trim().split('-')[0].toLowerCase();
  return RECAP_LANGUAGE_NAMES[baseLocale] ?? RECAP_LANGUAGE_NAMES.en;
}

function buildRecapPrompt(messages: RecapMessage[], locale = 'en') {
  const transcript = messages
    .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.text}`)
    .join('\n\n')
    .slice(-RECAP_PROMPT_CHARS);

  return [
    'Below is the tail of a coding session between a user and an AI assistant.',
    `Write both the title and recap in ${resolveRecapLanguage(locale)}. Follow the selected`,
    'interface language even when the transcript uses another language.',
    '',
    'Reply with ONLY a JSON object, no prose and no code fence:',
    '',
    '{"title": "...", "recap": "..."}',
    '',
    `- "title": 2-4 words naming what this session is about, like a tab label.`,
    '  Use natural capitalization for that language, no trailing punctuation,',
    '  no quotes. Name the subject, not the',
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
function parseRecapResponse(text: string) {
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
 * Runs the summarising call and stores the result. Used by the background scheduler and historical backfill CLI.
 *
 * @param {Object} params
 * @param {string} params.sessionId - Runtime session id (app or provider id).
 * @param {string} params.cwd - Project root; the helper session runs here.
 * @param {Function} params.runQuery - The provider's own query entry point,
 *   injected to keep this module free of a cycle back into the runtime layer.
 * @param {string} [params.model] - Model for the summarising call. Defaults to
 *   Claude's cheap tier; other providers pass what they can actually run.
 * @param {string|null} [params.fallbackModel] - What to use when `model` is
 *   empty. Claude's cheap tier by default; a provider that cannot run it passes
 *   null, which sends no model at all and lets the provider pick its own.
 * @param {Function} [params.onRecap] - Called with the stored result so the
 *   caller can push it to connected clients.
 * @param {boolean} [params.useIndexedHistory] - Read the provider-normalized
 *   history even when the session also has a transcript file. Codex and other
 *   non-Claude JSONL formats need this path because readTranscriptTail parses
 *   Claude's on-disk schema.
 * @param {Function} [params.fetchHistory] - Test seam for indexed history.
 * @param {string} [params.locale] - Selected interface locale. The prompt
 *   validates it against the frontend-supported locale list and falls back to
 *   English, preventing arbitrary client text from entering the helper prompt.
 */
export async function generateSessionRecap({
  sessionId,
  cwd,
  runQuery,
  model,
  fallbackModel = DEFAULT_RECAP_MODEL,
  onRecap,
  useIndexedHistory = false,
  fetchHistory,
  locale = 'en',
}: RecapInput) {
  const session = sessionsDb.getSessionById(sessionId)
    ?? sessionsDb.getSessionByProviderSessionId(sessionId);
  if (!session) return;

  // A private session keeps no recap: the summary would sit in the row as a
  // second copy of what the conversation was about, which is one more thing
  // to shred and one more thing a reader of the database learns. The title
  // stays whatever it was; the lists show the mechanical fallback.
  if (session.is_private) return;

  // A transcript file when the provider keeps one per session, the indexed
  // history when it keeps a shared store instead (OpenCode).
  const source = useIndexedHistory || !session.jsonl_path ? 'indexed' : 'claude';
  // Provider totals can exclude tool results while pagination includes them. Count the actual
  // normalized history, never infer oldest-message offsets from the UI's display count.
  let historyRows: AnyRecord[];
  let tail: { messages: RecapMessage[]; total: number };
  if (source === 'indexed') {
    const history = await (fetchHistory ?? ((id, options) => sessionsService.fetchHistory(id, options)))(
      session.session_id, { limit: 1_000_000, offset: 0 });
    historyRows = history.messages;
    tail = await readIndexedTranscriptTail(session.session_id, async () => history);
  } else {
    const content = await fs.readFile(session.jsonl_path!, 'utf8');
    historyRows = content.split(/\r?\n/).flatMap(line => {
      try { const row = JSON.parse(line); return row.type === 'user' || row.type === 'assistant' ? [row] : []; }
      catch { return []; }
    });
    tail = await readTranscriptTail(session.jsonl_path!);
  }
  const { messages, total } = tail;
  if (messages.length < 2) return;
  const historyTotal = historyRows.length;
  const memory = readTopicMemory(session.topic_memory);
  if (memory.source !== source || memory.cursor > historyTotal) {
    memory.cursor = 0; memory.charOffset = 0; memory.source = source;
  }
  if (session.recap && session.recap_message_count === total && memory.cursor >= historyTotal) return;
  const rows = historyRows.slice(memory.cursor);
  const batch = topicBatch(rows, memory, historyTotal);
  const topicPrompt = topicInstructions(memory, batch);
  // Historical tools/progress consume no topic budget. The separate tail above still gives
  // the recap current assistant outcomes, while cumulative subjects follow actual user asks.

  let responseText = '';
  const writer = {
    // The helper run has no user behind it, so nothing it does may raise a
    // notification.
    userId: null,
    send: (data: unknown) => {
      try {
        const parsed = (typeof data === 'string' ? JSON.parse(data) : data) as AnyRecord;
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

  // A model name is provider-specific: handing Claude's `haiku` to a Codex or
  // OpenCode helper starts a turn their app-server cannot serve, which fails
  // with no output and reads here as an unparseable reply. Callers that cannot
  // run the default pass fallbackModel: null and get the provider's own.
  const helperModel = model || fallbackModel || undefined;

  await runQuery(buildRecapPrompt(messages, locale) + '\n\n' + topicPrompt, {
    cwd,
    model: helperModel,
    permissionMode: 'bypassPermissions',
    // Nothing to do but read the text it was handed.
    toolsSettings: { disallowedTools: ['Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task'] },
    ephemeral: true,
    effort: 'low',
  }, writer);

  const result = parseRecapResponse(responseText);
  if (!result) {
    // An empty reply is a helper turn that never produced text — a different
    // failure from a model that answered in prose, and the one a wrong model
    // name causes, so say which happened.
    const reason = responseText.trim()
      ? 'unparseable reply'
      : `empty reply (model: ${helperModel || 'provider default'})`;
    console.warn(`[recap] ${sessionId}: ${reason}, keeping previous recap`);
    return;
  }

  // The app session id is the row key; the runtime may know the session by its
  // provider id, so resolve back to the row we actually read.
  const rowId = session.session_id;
  const current = sessionsDb.getSessionById(rowId);
  if (!current || current.is_private) return;
  const updatedMemory = mergeTopicResponse(responseText, memory, batch);
  if (!updatedMemory && /"topics"\s*:/.test(responseText)) {
    throw new Error('Topic update rejected: invalid structure or source quote; coverage retained');
  }
  let more = false;
  if (updatedMemory && sessionsDb.updateSessionTopicMemory(rowId, session.topic_memory, JSON.stringify(updatedMemory))) {
    more = updatedMemory.cursor < historyTotal || updatedMemory.charOffset > 0;
  }

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
  return more;
}

/**
 * Queues a recap after progress or turn completion.
 *
 * Coalesces calls until the fixed deadline. Safe on progress and completion.
 *
 * Consumed by the provider runtimes through the providers barrel. A fixed
 * deadline prevents frequent progress messages from postponing the first recap.
 */
export function scheduleSessionRecap(input: RecapInput) {
  const { cwd, runQuery } = input;
  if (!input.sessionId || !cwd || typeof runQuery !== 'function') return;
  // Progress uses the app id; a terminal event may carry the provider id.
  // They must share one deadline and one in-flight helper.
  const sessionId = (sessionsDb.getSessionById(input.sessionId)
    ?? sessionsDb.getSessionByProviderSessionId(input.sessionId))?.session_id ?? input.sessionId;
  latestRecaps.set(sessionId, { ...input, sessionId });
  if (pendingRecaps.has(sessionId) || inFlightRecaps.has(sessionId)) return;

  const timer = setTimeout(() => {
    pendingRecaps.delete(sessionId);
    const latest = latestRecaps.get(sessionId);
    latestRecaps.delete(sessionId);
    if (!latest) return;
    inFlightRecaps.add(sessionId);
    nextRefreshAt.set(sessionId, Date.now() + 60_000);
    void generateSessionRecap(latest)
      .then(more => { if (more && !latestRecaps.has(sessionId)) latestRecaps.set(sessionId, latest); })
      .catch((error: unknown) => {
        console.warn(`[recap] ${sessionId} failed:`, error instanceof Error ? error.message : error);
      })
      .finally(() => {
        inFlightRecaps.delete(sessionId);
        // Progress arriving during generation must get a subsequent pass.
        const next = latestRecaps.get(sessionId);
        if (next) scheduleSessionRecap(next);
      });
  }, Math.max(RECAP_DEBOUNCE_MS, (nextRefreshAt.get(sessionId) ?? 0) - Date.now()));
  timer.unref?.();
  pendingRecaps.set(sessionId, timer);
}

/** Provider teardown cancels queued work, including a follow-up during a helper run. */
export function cancelSessionRecap(sessionId: string) {
  const existing = pendingRecaps.get(sessionId);
  if (existing) clearTimeout(existing);
  pendingRecaps.delete(sessionId);
  latestRecaps.delete(sessionId);
  nextRefreshAt.delete(sessionId);
}

/** Test seam. */
export const __testing = {
  readTranscriptTail,
  readIndexedTranscriptTail,
  parseRecapResponse,
  buildRecapPrompt,
  generateRecap: generateSessionRecap,
};
