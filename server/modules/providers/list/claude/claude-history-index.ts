import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import readline from 'node:readline';
import { setImmediate } from 'node:timers/promises';

import Database from 'better-sqlite3';

import type { AnyRecord, FetchHistoryOptions, FetchHistoryResult, NormalizedMessage } from '@/shared/index.js';
import { extractToolResultImages } from '@/shared/index.js';

type Normalize = (raw: unknown, sessionId: string) => NormalizedMessage[];
type Pointer = { start: number; length: number };
type MessagePointer = Pointer & { id: string; part: number; kind: string; toolId: string | null };
type Metadata = { messages: Omit<MessagePointer, 'start' | 'length'>[]; tools: string[] };
type Index = {
  db: Database.Database; directory: string; signature: string; size: number; mtime: number;
  resume: number; tail: boolean; legacyOrdering: boolean; count: number; total: number;
  baseCount: number; baseTotal: number;
  head: Buffer; boundary: Buffer;
};
type Payload = { signature: string; tools: AnyRecord[]; bytes: number };
const activeCaches = new Set<ClaudeHistoryIndex>();
process.once('exit', () => { for (const cache of activeCaches) cache.close(); });

/**
 * Providers' Claude session reader and differential/benchmark tests use this
 * disposable offset index. Transcript payloads remain in their source files;
 * SQLite's bounded page cache and the weighted subagent LRU bound retained RAM.
 */
export class ClaudeHistoryIndex {
  private readonly indexes = new Map<string, Index>();
  private readonly payloads = new Map<string, Payload>();
  private readonly flights = new Map<string, Promise<FetchHistoryResult>>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly activeKeys = new Set<string>();
  private readonly capacityWaiters: Array<() => void> = [];
  private payloadBytes = 0;
  private readonly maxBytes: number;
  private readonly maxIndexes: number;
  private readonly indexBytes: number;

  constructor(options: { maxBytes?: number; maxIndexes?: number } = {}) {
    const configured = Number(process.env.CLAUDE_HISTORY_CACHE_BYTES);
    this.maxBytes = Math.max(128 * 1024, options.maxBytes ?? (Number.isFinite(configured) && configured > 0 ? configured : 32 * 1024 * 1024));
    this.maxIndexes = Math.max(1, options.maxIndexes ?? 8);
    // Reserve connection/statement bookkeeping as well as SQLite's page cache.
    this.indexBytes = Math.max(64 * 1024 + 4096, Math.min(8 * 1024 * 1024, Math.floor(this.maxBytes / 4)));
    activeCaches.add(this);
  }

  /** Allows the provider's tests and benchmark to measure the retained cache budget. */
  get stats() {
    return { estimatedBytes: this.payloadBytes + this.indexes.size * this.indexBytes, maxBytes: this.maxBytes, indexes: this.indexes.size, payloads: this.payloads.size };
  }

  /** Provider requests share identical in-flight pages; index mutations are serialized. */
  read(file: string, sessionId: string, providerSessionId: string, options: FetchHistoryOptions, normalize: Normalize): Promise<FetchHistoryResult> {
    const key = JSON.stringify([file, sessionId, providerSessionId]);
    const flightKey = JSON.stringify([key, String(options.limit ?? null), String(options.offset ?? 0)]);
    const existing = this.flights.get(flightKey);
    if (existing) return existing.then(result => structuredClone(result));
    const previous = this.queues.get(key) ?? Promise.resolve();
    const flight = previous.catch(() => {}).then(async () => {
      this.activeKeys.add(key);
      try { return await this.readPage(key, file, sessionId, providerSessionId, options, normalize); }
      finally {
        this.activeKeys.delete(key);
        for (const wake of this.capacityWaiters.splice(0)) wake();
      }
    });
    this.queues.set(key, flight);
    this.flights.set(flightKey, flight);
    void flight.finally(() => {
      this.flights.delete(flightKey);
      if (this.queues.get(key) === flight) this.queues.delete(key);
    }).catch(() => {});
    return flight.then(result => structuredClone(result));
  }

  /** Releases disposable index files; also called automatically on normal process exit. */
  close() {
    for (const index of this.indexes.values()) this.dispose(index);
    this.indexes.clear();
    this.payloads.clear();
    this.payloadBytes = 0;
    activeCaches.delete(this);
  }

  private dispose(index: Index) {
    index.db.close();
    fs.rmSync(index.directory, { recursive: true, force: true });
  }

  private trim() {
    while (this.stats.estimatedBytes > this.maxBytes && this.payloads.size) {
      const key = this.payloads.keys().next().value!;
      this.payloadBytes -= this.payloads.get(key)!.bytes;
      this.payloads.delete(key);
    }
  }

  private createIndex(): Index {
    // mkdtemp creates a private directory: cached metadata is never world-readable.
    const directory = fs.mkdtempSync(path.join(tmpdir(), 'vibespace-claude-history-'));
    const db = new Database(path.join(directory, 'offsets.sqlite'));
    db.pragma('journal_mode = DELETE');
    db.pragma('synchronous = OFF');
    db.pragma(`cache_size = -${Math.max(4, Math.floor((this.indexBytes - 64 * 1024) / 1024))}`);
    db.pragma('temp_store = FILE');
    db.exec(`
      CREATE TABLE rows (start INTEGER PRIMARY KEY, length INTEGER, time REAL, metadata TEXT);
      CREATE TABLE messages (id TEXT PRIMARY KEY, start INTEGER, length INTEGER, part INTEGER, kind TEXT, toolId TEXT, time REAL);
      CREATE INDEX message_order ON messages(time, start, part);
      CREATE TABLE tools (id TEXT PRIMARY KEY, start INTEGER, length INTEGER, time REAL);
    `);
    return { db, directory, signature: '', size: 0, mtime: 0, resume: 0, tail: false, legacyOrdering: false, count: 0, total: 0, baseCount: 0, baseTotal: 0, head: Buffer.alloc(0), boundary: Buffer.alloc(0) };
  }

  private async readBytes(handle: fsp.FileHandle, start: number, length: number) {
    const buffer = Buffer.allocUnsafe(length);
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await handle.read(buffer, filled, length - filled, start + filled);
      if (!bytesRead) throw new Error('Transcript changed during history read');
      filled += bytesRead;
    }
    return buffer;
  }

  private async readPage(key: string, file: string, sessionId: string, providerSessionId: string, options: FetchHistoryOptions, normalize: Normalize): Promise<FetchHistoryResult> {
    const handle = await fsp.open(file, 'r');
    try {
      const stat = await handle.stat();
      const signature = `${stat.dev}:${stat.ino}`;
      let index = this.indexes.get(key);
      let rewritten = false;
      if (index && stat.size > index.size && index.signature === signature) {
        // Detect a truncate-and-regrow between reads without rescanning the
        // unchanged prefix. This is the same append-only boundary as rollout readers.
        const head = await this.readBytes(handle, 0, index.head.length);
        const boundary = await this.readBytes(handle, index.size - index.boundary.length, index.boundary.length);
        rewritten = !head.equals(index.head) || !boundary.equals(index.boundary);
      }
      if (index && (rewritten || index.signature !== signature || stat.size < index.size || (stat.size === index.size && stat.mtimeMs !== index.mtime))) {
        this.indexes.delete(key);
        this.dispose(index);
        index = undefined;
      }
      if (!index) {
        // Other sessions can read in parallel. Only idle indexes may be evicted;
        // when the budget is fully pinned, wait for one owner to release a slot.
        while (this.indexes.size >= this.maxIndexes || this.stats.estimatedBytes + this.indexBytes > this.maxBytes) {
          if (this.payloads.size) {
            const payloadKey = this.payloads.keys().next().value!;
            this.payloadBytes -= this.payloads.get(payloadKey)!.bytes;
            this.payloads.delete(payloadKey);
          } else {
            const oldest = [...this.indexes.keys()].find(candidate => !this.activeKeys.has(candidate));
            if (oldest !== undefined) {
              this.dispose(this.indexes.get(oldest)!);
              this.indexes.delete(oldest);
            } else {
              await new Promise<void>(resolve => this.capacityWaiters.push(resolve));
            }
          }
        }
        index = this.createIndex();
        index.signature = signature;
      }
      this.indexes.delete(key);
      this.indexes.set(key, index);
      if (stat.size !== index.size || stat.mtimeMs !== index.mtime) {
        await this.refresh(index, handle, stat.size, sessionId, providerSessionId, normalize);
        index.head = await this.readBytes(handle, 0, Math.min(256, stat.size));
        index.boundary = await this.readBytes(handle, Math.max(0, stat.size - 256), Math.min(256, stat.size));
        index.size = stat.size;
        index.mtime = stat.mtimeMs;
      }
      const offset = Math.max(0, options.offset ?? 0);
      const limit = options.limit == null ? null : Math.max(0, options.limit);
      // Match Array.slice's integer conversion, including fractional pagination inputs.
      const integer = (value: number) => Number.isNaN(value) ? 0 : Math.trunc(value);
      const endValue = Math.max(0, index.count - offset);
      const startValue = limit === null ? 0 : Math.max(0, endValue - limit);
      const end = integer(endValue);
      const start = integer(startValue);
      // Walk backwards from the indexed tail: an offset-zero page must not
      // traverse the entire ordered index to skip all the older messages.
      const pointers = (index.db.prepare('SELECT * FROM messages ORDER BY time DESC, start DESC, part DESC LIMIT ? OFFSET ?')
        .all(end - start, index.count - end) as MessagePointer[]).reverse();
      const messages: NormalizedMessage[] = [];
      const rows = new Map<number, { raw: AnyRecord; bytes: number }>();
      let rowBytes = 0;
      const rowBudget = Math.min(4 * 1024 * 1024, this.maxBytes / 4);
      const load = async (pointer: Pointer) => {
        let raw = rows.get(pointer.start)?.raw;
        if (!raw) {
          const buffer = await this.readBytes(handle, pointer.start, pointer.length);
          raw = JSON.parse(buffer.toString('utf8')) as AnyRecord;
          await this.attachAgentTools(raw, file, sessionId, providerSessionId);
          const bytes = pointer.length * 2 + 256;
          // A full-history caller can request an arbitrarily large response;
          // its temporary dependency cache still must not retain every raw row.
          if (!raw.subagentTools && bytes <= rowBudget) {
            while (rowBytes + bytes > rowBudget && rows.size) {
              const oldest = rows.keys().next().value!;
              rowBytes -= rows.get(oldest)!.bytes;
              rows.delete(oldest);
            }
            rows.set(pointer.start, { raw, bytes }); rowBytes += bytes;
          }
        }
        return raw;
      };
      let lastYield = performance.now();
      let normalizedStart = -1;
      let normalizedRow: NormalizedMessage[] = [];
      for (const pointer of pointers) {
        const raw = await load(pointer);
        if (normalizedStart !== pointer.start) {
          normalizedRow = normalize(raw, sessionId);
          normalizedStart = pointer.start;
        }
        const message = normalizedRow[pointer.part];
        if (!message) continue;
        if (message.kind === 'tool_use' && message.toolId) {
          const resultPointer = index.db.prepare('SELECT start, length FROM tools WHERE id = ?').get(message.toolId) as Pointer | undefined;
          if (resultPointer) {
            const resultRaw = await load(resultPointer);
            // The last result for this id in the last chronological row wins.
            const part = [...resultRaw.message.content].reverse().find((item: AnyRecord) => item.type === 'tool_result' && item.tool_use_id === message.toolId);
            const images = extractToolResultImages(part.content);
            message.toolResult = {
              content: typeof part.content === 'string' ? part.content : JSON.stringify(part.content),
              isError: Boolean(part.is_error), ...(images ? { images } : {}),
              toolUseResult: resultRaw.toolUseResult,
              interruptedByShutdown: Boolean(resultRaw.interruptedByShutdown),
            };
            message.subagentTools = resultRaw.subagentTools;
          }
        }
        messages.push(message);
        if (performance.now() - lastYield >= 8) { await setImmediate(); lastYield = performance.now(); }
      }
      this.trim();
      return { messages, total: index.total, hasMore: limit !== null && startValue > 0, offset, limit };
    } catch (error) {
      // A failed refresh is never reused as a valid index on the next request.
      const index = this.indexes.get(key);
      if (index) { this.indexes.delete(key); this.dispose(index); }
      throw error;
    } finally { await handle.close(); }
  }

  private async refresh(index: Index, handle: fsp.FileHandle, size: number, sessionId: string, providerSessionId: string, normalize: Normalize) {
    const { db } = index;
    if (index.tail) {
      db.exec('ROLLBACK TO tail; RELEASE tail');
      index.count = index.baseCount;
      index.total = index.baseTotal;
      index.tail = false;
    }
    const insertRow = db.prepare('INSERT OR REPLACE INTO rows VALUES (?, ?, ?, ?)');
    const insertMessage = db.prepare('INSERT OR IGNORE INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)');
    const existingMessage = db.prepare('SELECT time, start, part, kind FROM messages WHERE id = ?');
    const replaceMessage = db.prepare('UPDATE messages SET start=?, length=?, part=?, kind=?, toolId=?, time=? WHERE id=?');
    const insertTool = db.prepare(`INSERT INTO tools VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET start=excluded.start, length=excluded.length, time=excluded.time
      WHERE (excluded.time, excluded.start) >= (tools.time, tools.start)`);
    const addMetadata = (pointer: Pointer, time: number, metadata: Metadata) => {
      for (const message of metadata.messages) {
        const result = insertMessage.run(message.id, pointer.start, pointer.length, message.part, message.kind, message.toolId, time);
        if (result.changes) {
          index.count++;
          if (message.kind !== 'tool_result') index.total++;
        } else {
          const existing = existingMessage.get(message.id) as { time: number; start: number; part: number; kind: string };
          if (time < existing.time || (time === existing.time && (pointer.start < existing.start || (pointer.start === existing.start && message.part < existing.part)))) {
            replaceMessage.run(pointer.start, pointer.length, message.part, message.kind, message.toolId, time, message.id);
            index.total += Number(message.kind !== 'tool_result') - Number(existing.kind !== 'tool_result');
          }
        }
      }
      for (const id of metadata.tools) insertTool.run(id, pointer.start, pointer.length, time);
    };
    const readMetadata = (raw: AnyRecord): Metadata => ({
      messages: normalize(raw, sessionId).map((message, part) => ({ id: message.id, part, kind: message.kind, toolId: message.toolId ?? null })),
      tools: raw.message?.role === 'user' && Array.isArray(raw.message?.content)
        ? raw.message.content.filter((part: AnyRecord) => part.type === 'tool_result' && part.tool_use_id).map((part: AnyRecord) => part.tool_use_id) : [],
    });
    const ingest = (buffer: Buffer, start: number) => {
      let raw: AnyRecord;
      try { raw = JSON.parse(buffer.toString('utf8')) as AnyRecord; } catch { return; }
      if (raw?.sessionId !== providerSessionId || raw.isSidechain === true || raw.message?.isSidechain === true) return;
      const time = new Date(raw.timestamp || 0).getTime();
      if (!Number.isFinite(time)) index.legacyOrdering = true;
      const metadata = readMetadata(raw);
      const pointer = { start, length: buffer.length };
      insertRow.run(start, buffer.length, Number.isFinite(time) ? time : null, index.legacyOrdering ? JSON.stringify(metadata) : null);
      addMetadata(pointer, Number.isFinite(time) ? time : 0, metadata);
    };
    let pending: Buffer[] = [];
    let pendingLength = 0;
    let position = index.resume;
    let lineStart = position;
    let lastYield = performance.now();
    db.exec('BEGIN');
    if (size > position) {
      const stream = fs.createReadStream('', { fd: handle.fd, autoClose: false, start: position, end: size - 1, highWaterMark: 64 * 1024 });
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        let from = 0;
        // Buffer.indexOf scans in native code; a JS loop over hundreds of
        // millions of bytes dominates cold reads even when each row is small.
        let lf = chunk.indexOf(10);
        let cr = chunk.indexOf(13);
        while (lf >= 0 || cr >= 0) {
          const i = lf < 0 ? cr : cr < 0 ? lf : Math.min(lf, cr);
          const segment = chunk.subarray(from, i);
          const line = pendingLength ? Buffer.concat([...pending, segment], pendingLength + segment.length) : segment;
          if (line.length) ingest(line, lineStart);
          pending = []; pendingLength = 0;
          from = i + 1;
          lineStart = position + from;
          if (i === lf) lf = chunk.indexOf(10, from);
          if (i === cr) cr = chunk.indexOf(13, from);
          if (performance.now() - lastYield >= 8) {
            await setImmediate(); lastYield = performance.now();
          }
        }
        if (from < chunk.length) {
          // Copy only the unfinished line, so a short tail cannot retain a whole chunk.
          const segment = Buffer.from(chunk.subarray(from));
          pending.push(segment); pendingLength += segment.length;
        }
        position += chunk.length;
      }
    }
    index.resume = lineStart;
    db.exec('COMMIT');
    // Invalid dates make the legacy JS comparator non-transitive. Preserve its
    // stable-sort behavior using compact metadata only, never transcript bodies.
    const legacySort = async () => {
      if (!index.legacyOrdering) return;
      const rows = db.prepare('SELECT start, length, time FROM rows ORDER BY start').all() as (Pointer & { time: number | null })[];
      rows.sort((a, b) => (a.time ?? NaN) - (b.time ?? NaN));
      db.exec('DELETE FROM messages; DELETE FROM tools');
      index.count = 0; index.total = 0;
      let rank = 0;
      const readCached = db.prepare('SELECT metadata FROM rows WHERE start=?');
      const cacheMetadata = db.prepare('UPDATE rows SET metadata=? WHERE start=?');
      for (const row of rows) {
        let { metadata } = readCached.get(row.start) as { metadata: string | null };
        if (metadata === null) {
          const buffer = await this.readBytes(handle, row.start, row.length);
          metadata = JSON.stringify(readMetadata(JSON.parse(buffer.toString('utf8')) as AnyRecord));
          cacheMetadata.run(metadata, row.start);
        }
        addMetadata(row, rank++, JSON.parse(metadata) as Metadata);
        if (performance.now() - lastYield >= 8) { await setImmediate(); lastYield = performance.now(); }
      }
    };
    await legacySort();
    index.baseCount = index.count; index.baseTotal = index.total;
    if (pendingLength) {
      db.exec('SAVEPOINT tail'); index.tail = true;
      ingest(Buffer.concat(pending, pendingLength), lineStart);
      await legacySort();
    }
  }

  private async attachAgentTools(raw: AnyRecord, file: string, sessionId: string, providerSessionId: string) {
    const agentId = raw.toolUseResult?.agentId;
    if (!agentId) return;
    const agentFileName = `agent-${agentId}.jsonl`;
    // Match the legacy directory lookup: ids must name one discovered file.
    if (path.basename(agentFileName) !== agentFileName) return;
    const project = path.dirname(file);
    const ids = [...new Set([path.basename(file, '.jsonl'), providerSessionId, sessionId].filter(Boolean))];
    for (const directory of [...ids.map(id => path.join(project, id, 'subagents')), project]) {
      const agentFile = path.join(directory, agentFileName);
      let stat: fs.Stats;
      try { stat = await fsp.stat(agentFile); } catch { continue; }
      const signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
      let payload = this.payloads.get(agentFile);
      if (payload?.signature !== signature) {
        if (payload) { this.payloadBytes -= payload.bytes; this.payloads.delete(agentFile); }
        const tools: AnyRecord[] = [];
        const rl = readline.createInterface({ input: fs.createReadStream(agentFile), crlfDelay: Infinity });
        let lastYield = performance.now();
        let complete = true;
        try {
          for await (const line of rl) {
            let entry: AnyRecord;
            try { entry = JSON.parse(line) as AnyRecord; } catch { continue; }
            try {
              if (entry?.message?.role === 'assistant' && Array.isArray(entry.message.content)) {
                for (const part of entry.message.content) if (part.type === 'tool_use') {
                  tools.push({ toolId: part.id, toolName: part.name, toolInput: part.input, timestamp: entry.timestamp });
                }
              }
              if (entry?.message?.role === 'user' && Array.isArray(entry.message.content)) {
                for (const part of entry.message.content) {
                  if (part.type !== 'tool_result') continue;
                  const tool = tools.find(candidate => candidate.toolId === part.tool_use_id);
                  if (tool) tool.toolResult = {
                    content: typeof part.content === 'string' ? part.content : Array.isArray(part.content)
                      ? part.content.map((item: AnyRecord) => item?.text || '').join('\n') : JSON.stringify(part.content),
                    isError: Boolean(part.is_error),
                  };
                }
              }
            } catch {
              // A malformed content part only invalidates this line.
            }
            if (performance.now() - lastYield >= 8) { await setImmediate(); lastYield = performance.now(); }
          }
        } catch {
          complete = false;
          // Match the legacy reader: an unavailable subagent must not hide the
          // parent conversation, and any tools read before an error survive.
        }
        payload = { signature, tools, bytes: Buffer.byteLength(JSON.stringify(tools)) * 2 + agentFile.length * 2 + 128 };
        if (complete && payload.bytes <= this.maxBytes - this.indexes.size * this.indexBytes) {
          this.payloads.set(agentFile, payload); this.payloadBytes += payload.bytes; this.trim();
        }
      } else {
        this.payloads.delete(agentFile); this.payloads.set(agentFile, payload);
      }
      if (payload.tools.length) raw.subagentTools = structuredClone(payload.tools);
      return;
    }
  }
}
