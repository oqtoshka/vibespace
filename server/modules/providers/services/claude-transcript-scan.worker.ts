/**
 * Worker-thread body of the Claude transcript scan.
 *
 * Long sessions run for months and their transcripts reach gigabytes. Parsing one
 * on the server's main thread freezes every request for as long as it takes, and
 * the garbage it leaves behind stalls the loop again afterwards; a single string
 * cannot even hold a file past V8's ~512 MB limit. Here the parsing has its own
 * thread and its own heap, the file is walked line by line, and only a bounded
 * result crosses back.
 *
 * This file is the entry point of a Worker, so it imports nothing but Node
 * built-ins: the main-thread module graph (database, plugins) must not load here.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { parentPort, workerData } from 'node:worker_threads';

import type {
  ClaudeTranscriptScanRequest,
  ClaudeTranscriptScanResult,
  ClaudeTranscriptScanState,
} from '@/shared/types.js';

type Row = Record<string, unknown>;

const READ_CHUNK_BYTES = 4 * 1024 * 1024;
/** A record past this is a pasted blob, not conversation; it is skipped unbuffered. */
const MAX_LINE_BYTES = 32 * 1024 * 1024;
const FINGERPRINT_BYTES = 4 * 1024;
const CHECKPOINT_EVERY_ROWS = 512;
/** More than the recap's 40 lines: stripping launch preambles can empty some. */
const TAIL_MESSAGES = 120;
/** Past the longest launch preamble, which must be stripped before any cut. */
const TAIL_TEXT_CHARS = 200_000;
/** topicBatch stops at 80 messages; this only bounds what is carried back. */
const MAX_TOPIC_USER_ROWS = 200;

const USER_MARKER = Buffer.from('"type":"user"');
const ASSISTANT_MARKER = Buffer.from('"type":"assistant"');

async function readBytes(handle: fs.FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
}

/**
 * Yields each newline-terminated line of `[start, end)` with its byte offset,
 * and reports through `onEnd` the offset just past the last complete line. An
 * unterminated tail is left for the next scan: the writer may be mid-record.
 */
async function* readLines(
  handle: fs.FileHandle,
  start: number,
  end: number,
  onEnd: (offset: number) => void = () => {},
): AsyncGenerator<{ line: Buffer; offset: number }> {
  let position = start;
  let lineStart = start;
  let pending: Buffer[] = [];
  let pendingLength = 0;
  let oversized = false;
  while (position < end) {
    const chunk = await readBytes(handle, position, Math.min(READ_CHUNK_BYTES, end - position));
    if (chunk.length === 0) break;
    let from = 0;
    let newline = chunk.indexOf(0x0a);
    while (newline !== -1) {
      if (!oversized && pendingLength + newline - from <= MAX_LINE_BYTES) {
        const segment = chunk.subarray(from, newline);
        const line = pendingLength ? Buffer.concat([...pending, segment], pendingLength + segment.length) : segment;
        if (line.length) yield { line, offset: lineStart };
      }
      pending = [];
      pendingLength = 0;
      oversized = false;
      from = newline + 1;
      lineStart = position + from;
      newline = chunk.indexOf(0x0a, from);
    }
    if (from < chunk.length && !oversized) {
      if (pendingLength + chunk.length - from > MAX_LINE_BYTES) {
        pending = [];
        pendingLength = 0;
        oversized = true;
      } else {
        // A copy: a subarray would pin the whole read chunk for one short tail.
        const rest = Buffer.from(chunk.subarray(from));
        pending.push(rest);
        pendingLength += rest.length;
      }
    }
    position += chunk.length;
  }
  onEnd(lineStart);
}

function parseConversationRow(line: Buffer): Row | null {
  // Most bytes are tool progress; the marker keeps JSON.parse off those lines.
  if (!line.includes(USER_MARKER) && !line.includes(ASSISTANT_MARKER)) return null;
  let entry: Row;
  try {
    entry = JSON.parse(line.toString('utf8')) as Row;
  } catch {
    return null;
  }
  return entry?.type === 'user' || entry?.type === 'assistant' ? entry : null;
}

/** The prose of a record; tool calls and results are bytes without meaning here. */
function rowText(entry: Row): string {
  const content = (entry.message as Row | undefined)?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block: Row) => block?.type === 'text' && typeof block.text === 'string')
    .map((block: Row) => block.text as string)
    .join('\n');
}

function freshState(): ClaudeTranscriptScanState {
  return { offset: 0, fingerprint: '', total: 0, historyTotal: 0, tail: [], checkpoints: [] };
}

async function fingerprintBefore(handle: fs.FileHandle, offset: number): Promise<string> {
  const length = Math.min(FINGERPRINT_BYTES, offset);
  const bytes = await readBytes(handle, offset - length, length);
  return createHash('sha1').update(bytes).digest('hex');
}

/** A rewind rewrites the transcript; any such change restarts from byte zero. */
async function resumableState(
  handle: fs.FileHandle,
  size: number,
  state: ClaudeTranscriptScanState | null,
): Promise<ClaudeTranscriptScanState> {
  if (!state || size < state.offset) return freshState();
  return await fingerprintBefore(handle, state.offset) === state.fingerprint ? state : freshState();
}

async function extendState(
  handle: fs.FileHandle,
  size: number,
  state: ClaudeTranscriptScanState,
): Promise<ClaudeTranscriptScanState> {
  const next = { ...state, tail: [...state.tail], checkpoints: [...state.checkpoints] };
  const lines = readLines(handle, state.offset, size, (offset) => { next.offset = offset; });
  for await (const { line, offset } of lines) {
    const entry = parseConversationRow(line);
    if (!entry) continue;
    if (next.historyTotal % CHECKPOINT_EVERY_ROWS === 0) next.checkpoints.push([next.historyTotal, offset]);
    next.historyTotal += 1;
    const text = rowText(entry).trim();
    if (!text || text.startsWith('<local-command') || text.startsWith('<system-reminder')) continue;
    next.total += 1;
    next.tail.push({ role: entry.type as string, text: text.slice(0, TAIL_TEXT_CHARS) });
    if (next.tail.length > TAIL_MESSAGES * 2) next.tail.splice(0, next.tail.length - TAIL_MESSAGES);
  }
  next.tail = next.tail.slice(-TAIL_MESSAGES);
  next.fingerprint = await fingerprintBefore(handle, next.offset);
  return next;
}

/** A row carrying exactly what topic extraction reads: user prose and its ids. */
function slimRow(entry: Row, text: string): Row {
  if (entry.type !== 'user' || !text) return { type: entry.type };
  const message = entry.message as Row | undefined;
  return {
    type: entry.type,
    id: entry.id,
    uuid: entry.uuid,
    kind: entry.kind,
    message: { id: message?.id, content: [{ type: 'text', text }] },
  };
}

async function readRowsFrom(
  handle: fs.FileHandle,
  state: ClaudeTranscriptScanState,
  cursor: number,
  maxUserChars: number,
): Promise<Row[]> {
  let start: [number, number] = [0, 0];
  for (const checkpoint of state.checkpoints) {
    if (checkpoint[0] > cursor) break;
    start = checkpoint;
  }
  const rows: Row[] = [];
  let index = start[0];
  let userChars = 0;
  let userRows = 0;
  for await (const { line } of readLines(handle, start[1], state.offset)) {
    const entry = parseConversationRow(line);
    if (!entry) continue;
    if (index >= cursor) {
      const text = entry.type === 'user' ? rowText(entry) : '';
      rows.push(slimRow(entry, text));
      if (text) {
        userChars += text.length;
        userRows += 1;
      }
      if (userChars >= maxUserChars || userRows >= MAX_TOPIC_USER_ROWS) break;
    }
    index += 1;
  }
  return rows;
}

async function scan(request: ClaudeTranscriptScanRequest): Promise<ClaudeTranscriptScanResult> {
  const handle = await fs.open(request.filePath, 'r');
  try {
    const { size } = await handle.stat();
    const state = await extendState(handle, size, await resumableState(handle, size, request.state));
    const rows = request.cursor === null || request.cursor >= state.historyTotal
      ? []
      : await readRowsFrom(handle, state, request.cursor, request.maxUserChars);
    return { state, rows };
  } finally {
    await handle.close();
  }
}

parentPort?.postMessage(await scan(workerData as ClaudeTranscriptScanRequest));
