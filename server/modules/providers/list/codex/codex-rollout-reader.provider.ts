import fs from 'node:fs/promises';

/**
 * Incremental reader for append-only Codex rollout JSONL files.
 *
 * A long-lived Codex thread's rollout grows past a gigabyte, and the history
 * adapter used to re-parse the whole file for every page request (several
 * seconds per page). The parser that turns rollout lines into history entries
 * is stateful (rollbacks, exec/wait pairing, sub-agent bookkeeping), so a byte
 * index alone cannot answer a page. Instead this reader keeps the parser itself
 * alive per file and feeds it only the bytes appended since the last read.
 *
 * Correctness rests on Codex appending to its rollouts and never rewriting
 * them. Every read re-validates that assumption: a different inode, a file
 * shorter than what was parsed, a same-length file with a new mtime, an
 * unterminated last line that later grew, or head/boundary bytes that no
 * longer match all discard the state and parse the file from byte 0, so a
 * truncated, rotated or rewritten file yields what a full read yields. The one
 * blind spot is a rewrite that keeps the head and boundary bytes, changes
 * only the middle and also grows the file; Codex never does that.
 */

/** The parser contract the reader drives; one instance covers one file. */
type RolloutLineParser = {
  /**
   * Consumes one physical line (without its newline) and returns true when
   * the line left something retained in the parser state (a history entry),
   * which is what the cache budget counts.
   */
  consume(line: string): boolean;
};

type CachedRollout<P extends RolloutLineParser> = {
  parser: P;
  dev: number;
  ino: number;
  /** Bytes of the file already fed to the parser. */
  parsedBytes: number;
  mtimeMs: number;
  /** First bytes of the file, to notice a rewrite that kept the length. */
  head: Buffer;
  /** Bytes right before `parsedBytes`, to notice a rewrite of the parsed range. */
  boundary: Buffer;
  /** True when the last consumed line had no trailing newline. */
  unterminatedTail: boolean;
  /** Rough bytes retained by the parser, for the cache budget. */
  retainedBytes: number;
  /** Bumped whenever the parser consumed new lines. */
  generation: number;
};

const READ_CHUNK_BYTES = 8 * 1024 * 1024;
const FINGERPRINT_BYTES = 256;
/** Retained-parser budget across files; the most recently used file is always kept. */
const CACHE_BUDGET_BYTES = 384 * 1024 * 1024;

const cache = new Map<string, CachedRollout<RolloutLineParser>>();
const inFlight = new Map<string, Promise<unknown>>();
/** Global, so a re-created parser never reuses a generation a caller cached. */
let generationCounter = 0;

async function readBytes(handle: fs.FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return filled === length ? buffer : buffer.subarray(0, filled);
}

/**
 * Feeds `[start, size)` to the parser line by line. Splitting on the 0x0A byte
 * is UTF-8 safe. A trailing fragment without a newline is consumed only when
 * it is a complete JSON value, matching what readline plus JSON.parse did for
 * a file whose writer had finished the record but not yet the newline; an
 * incomplete fragment stays unparsed and is re-read on the next call.
 */
async function feed<P extends RolloutLineParser>(
  handle: fs.FileHandle,
  entry: CachedRollout<P>,
  size: number,
): Promise<void> {
  let position = entry.parsedBytes;
  let carry: Buffer = Buffer.alloc(0);
  let consumedAny = false;
  while (position < size) {
    const chunk = await readBytes(handle, position, Math.min(READ_CHUNK_BYTES, size - position));
    if (chunk.length === 0) break;
    position += chunk.length;
    const data = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    let lineStart = 0;
    let newline = data.indexOf(0x0a, lineStart);
    while (newline !== -1) {
      const line = data.toString('utf8', lineStart, newline);
      if (entry.parser.consume(line)) entry.retainedBytes += newline - lineStart;
      entry.parsedBytes += newline - lineStart + 1;
      consumedAny = true;
      lineStart = newline + 1;
      newline = data.indexOf(0x0a, lineStart);
    }
    // Copy the fragment: a subarray would pin the whole 8 MiB chunk.
    carry = Buffer.from(data.subarray(lineStart));
  }
  entry.unterminatedTail = false;
  if (carry.length) {
    const fragment = carry.toString('utf8');
    let complete = false;
    try { JSON.parse(fragment); complete = true; } catch { /* still being written */ }
    if (complete) {
      if (entry.parser.consume(fragment)) entry.retainedBytes += carry.length;
      entry.parsedBytes += carry.length;
      entry.unterminatedTail = true;
      consumedAny = true;
    }
  }
  if (consumedAny) entry.generation = ++generationCounter;
}

function evictOverBudget(keep: string): void {
  let total = 0;
  for (const value of cache.values()) total += value.retainedBytes;
  // Map iteration order is insertion order; reads re-insert, so oldest first.
  for (const [key, value] of cache) {
    if (total <= CACHE_BUDGET_BYTES) break;
    if (key === keep) continue;
    cache.delete(key);
    total -= value.retainedBytes;
  }
}

async function readRolloutUncoalesced<P extends RolloutLineParser>(
  filePath: string,
  createParser: () => P,
): Promise<{ parser: P; generation: number }> {
  const handle = await fs.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    const size = stat.size;
    let entry = cache.get(filePath) as CachedRollout<P> | undefined;
    if (entry) {
      let reusable = entry.dev === stat.dev && entry.ino === stat.ino && size >= entry.parsedBytes;
      if (reusable && entry.unterminatedTail && size > entry.parsedBytes) {
        // The "complete" last line kept growing: a full read joins those
        // bytes into one line, so the earlier consumption no longer holds.
        reusable = false;
      }
      if (reusable && size === entry.parsedBytes && stat.mtimeMs !== entry.mtimeMs) {
        // Same length but touched: an append always grows the file, so this
        // is a rewrite (or a bare touch). Re-reading is the safe answer.
        reusable = false;
      }
      if (reusable && size > entry.parsedBytes) {
        const head = await readBytes(handle, 0, entry.head.length);
        const boundary = await readBytes(handle, entry.parsedBytes - entry.boundary.length, entry.boundary.length);
        reusable = head.equals(entry.head) && boundary.equals(entry.boundary);
      }
      if (!reusable) {
        cache.delete(filePath);
        entry = undefined;
      }
    }
    if (!entry) {
      entry = {
        parser: createParser(), dev: stat.dev, ino: stat.ino, parsedBytes: 0, mtimeMs: stat.mtimeMs,
        head: Buffer.alloc(0), boundary: Buffer.alloc(0), unterminatedTail: false, retainedBytes: 0,
        generation: ++generationCounter,
      };
    }
    if (size > entry.parsedBytes) await feed(handle, entry, size);
    entry.mtimeMs = stat.mtimeMs;
    entry.head = await readBytes(handle, 0, Math.min(FINGERPRINT_BYTES, entry.parsedBytes));
    const boundaryLength = Math.min(FINGERPRINT_BYTES, entry.parsedBytes);
    entry.boundary = await readBytes(handle, entry.parsedBytes - boundaryLength, boundaryLength);
    cache.delete(filePath);
    cache.set(filePath, entry as CachedRollout<RolloutLineParser>);
    evictOverBudget(filePath);
    return { parser: entry.parser, generation: entry.generation };
  } finally {
    await handle.close();
  }
}

/**
 * Codex history adapter (codex-sessions.provider) reads rollout state through
 * this. Returns the parser after it has consumed every complete line of the
 * file, plus a generation number that changes whenever the parser state did,
 * so the caller can cache derived views (sorted, normalized) per generation.
 * Concurrent reads of one file share a single pass. The returned parser is
 * shared and must be treated as read-only by the caller.
 */
export async function readCodexRollout<P extends RolloutLineParser>(
  filePath: string,
  createParser: () => P,
): Promise<{ parser: P; generation: number }> {
  // Chain behind any read of the same file so two passes never feed one parser.
  const previous = inFlight.get(filePath) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => readRolloutUncoalesced(filePath, createParser));
  inFlight.set(filePath, next);
  try {
    return await next;
  } finally {
    if (inFlight.get(filePath) === next) inFlight.delete(filePath);
  }
}

/** Codex history tests drop every cached parser to force a full re-read. */
export function clearCodexRolloutCache(): void {
  cache.clear();
}
