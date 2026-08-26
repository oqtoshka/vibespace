import os from 'node:os';
import path from 'node:path';
import { open, stat } from 'node:fs/promises';

import { sessionsDb } from '@/modules/database/index.js';
import { claimPendingCliSession } from '@/modules/providers/services/pending-cli-sessions.service.js';
import {
  buildLookupMap,
  extractFirstValidJsonlData,
  findFilesRecursivelyCreatedAfter,
  normalizeSessionName,
  readFileTimestamps,
  shouldReplaceSessionName,
} from '@/shared/utils.js';
import type { SessionNameSource } from '@/shared/utils.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';

type ParsedSession = {
  sessionId: string;
  projectPath: string;
  sessionName?: string;
  nameSource?: SessionNameSource;
};

const PLACEHOLDER_NAME = 'Untitled Claude Session';

/**
 * Title candidates the Claude CLI leaves in a transcript, best first.
 *
 * `custom-title` is a rename the user typed into the CLI, `ai-title` is the
 * CLI's own generated summary of the conversation, and `last-prompt` is just
 * the most recent thing the user typed. Ranking matters because all three are
 * appended repeatedly: a plain "scan backwards for the first title-ish event"
 * almost always lands on a `last-prompt`, which is why sessions ended up named
 * after a message instead of their topic.
 */
const TITLE_EVENTS = [
  { type: 'custom-title', field: 'customTitle', source: 'ai' },
  { type: 'ai-title', field: 'aiTitle', source: 'ai' },
  { type: 'last-prompt', field: 'lastPrompt', source: 'derived' },
] as const satisfies ReadonlyArray<{ type: string; field: string; source: SessionNameSource }>;

type TitleCandidate = { name: string; source: SessionNameSource };

/**
 * Where the last title scan of a transcript stopped, and what it had found.
 *
 * The watcher re-indexes a transcript on every append, and a live session is
 * appended to constantly — so reading the whole file each time is O(session
 * size) work per message. On this developer's Mac that meant 38 full reads of a
 * 93 MB transcript in 11 minutes: ~200 ms of blocked event loop apiece plus
 * gigabytes of allocation churn, which is exactly the kind of stall that makes
 * the deployment's health probe time out and restart the server underneath live
 * agent runs.
 *
 * Transcripts are append-only, and the scan takes the newest event of each
 * kind, so resuming from the previous end-of-file and letting new events
 * override the remembered ones gives the same answer as re-reading everything.
 */
type TitleScanState = {
  sessionId: string;
  /** Bytes already scanned. Always a line boundary, never mid-record. */
  consumedBytes: number;
  /** Newest value seen so far per title event type. */
  found: Map<string, string>;
};

const titleScanCache = new Map<string, TitleScanState>();
// A full rescan walks every transcript ever written, so the cache needs a
// ceiling. Entries are tiny; dropping all of them just costs one re-read each.
const TITLE_SCAN_CACHE_LIMIT = 1000;

/**
 * Session indexer for Claude transcript artifacts.
 */
export class ClaudeSessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'claude' as const;
  private readonly claudeHome = path.join(os.homedir(), '.claude');

  /**
   * Returns true when a JSONL file is a subagent transcript or tool result
   * rather than a top-level session.
   *
   * Claude stores subagent transcripts under a `subagents/` directory and
   * tool results under a `tool-results/` directory, e.g.
   * `~/.claude/projects/<encoded-cwd>/<session-id>/subagents/agent-<id>.jsonl`.
   * Those files repeat the parent session's `sessionId`, so indexing them as
   * standalone sessions overwrites the parent row's `jsonl_path` and corrupts
   * the main session record. The recursive scan in `synchronize()` reaches
   * them, so both entry points must skip them.
   */
  private isSubagentTranscript(filePath: string): boolean {
    const pathParts = path.normalize(filePath).split(path.sep);
    return pathParts.includes('subagents') || pathParts.includes('tool-results');
  }

  /**
   * Scans ~/.claude/projects and upserts discovered sessions into DB.
   */
  async synchronize(since?: Date): Promise<number> {
    const nameMap = await buildLookupMap(path.join(this.claudeHome, 'history.jsonl'), 'sessionId', 'display');
    const files = await findFilesRecursivelyCreatedAfter(
      path.join(this.claudeHome, 'projects'),
      '.jsonl',
      since ?? null
    );

    let processed = 0;
    for (const filePath of files) {
      if (this.isSubagentTranscript(filePath)) {
        continue;
      }

      const parsed = await this.processSessionFile(filePath, nameMap);
      if (!parsed) {
        continue;
      }

      const timestamps = await readFileTimestamps(filePath);
      sessionsDb.createSession(
        parsed.sessionId,
        this.provider,
        parsed.projectPath,
        parsed.sessionName,
        timestamps.createdAt,
        timestamps.updatedAt,
        filePath,
        parsed.nameSource
      );
      processed += 1;
    }

    return processed;
  }

  /**
   * Parses and upserts one Claude session JSONL file.
   */
  async synchronizeFile(filePath: string): Promise<string | null> {
    if (!filePath.endsWith('.jsonl')) {
      return null;
    }
    // A live subagent write must not re-hijack its parent's session row.
    if (this.isSubagentTranscript(filePath)) {
      return null;
    }

    const nameMap = await buildLookupMap(path.join(this.claudeHome, 'history.jsonl'), 'sessionId', 'display');
    // Only the live watcher path may claim a waiting terminal: the bulk rescan
    // in synchronize() also walks years-old transcripts, which must never
    // attach themselves to a freshly opened empty chat.
    const parsed = await this.processSessionFile(filePath, nameMap, { claimPendingCliSession: true });
    if (!parsed) {
      return null;
    }

    const timestamps = await readFileTimestamps(filePath);
    return sessionsDb.createSession(
      parsed.sessionId,
      this.provider,
      parsed.projectPath,
      parsed.sessionName,
      timestamps.createdAt,
      timestamps.updatedAt,
      filePath,
      parsed.nameSource
    );
  }

  /**
   * Extracts session metadata from one Claude JSONL session file.
   */
  private async processSessionFile(
    filePath: string,
    nameMap: Map<string, string>,
    options?: { claimPendingCliSession?: boolean }
  ): Promise<ParsedSession | null> {
    const parsed = await extractFirstValidJsonlData(filePath, (rawData) => {
      const data = rawData as Record<string, unknown>;
      const sessionId = typeof data.sessionId === 'string' ? data.sessionId : undefined;
      const projectPath = typeof data.cwd === 'string' ? data.cwd : undefined;

      if (!sessionId || !projectPath) {
        return null;
      }

      return {
        sessionId,
        projectPath,
      };
    });

    if (!parsed) {
      return null;
    }

    // A session born in the Terminal tab runs the real CLI, which allocates
    // its own session id the app never hears about. If a terminal registered
    // itself as waiting for a fresh CLI session in this project, bind this
    // never-seen-before id to that app session so the chat view the user has
    // open fills in instead of the sidebar growing a duplicate row.
    if (options?.claimPendingCliSession
      && !sessionsDb.getSessionByProviderSessionId(parsed.sessionId)
      && !sessionsDb.getSessionById(parsed.sessionId)) {
      const waitingAppSessionId = claimPendingCliSession(this.provider, parsed.projectPath);
      if (waitingAppSessionId) {
        sessionsDb.assignProviderSessionId(waitingAppSessionId, parsed.sessionId);
      }
    }

    // App-created sessions are keyed by an app id, so disk-discovered provider
    // ids must be resolved through the provider-id mapping first.
    const existingSession = sessionsDb.getSessionByProviderSessionId(parsed.sessionId)
      ?? sessionsDb.getSessionById(parsed.sessionId);
    const existingSessionName = existingSession?.custom_name;
    const hasRealExistingName = Boolean(existingSessionName)
      && existingSessionName !== PLACEHOLDER_NAME;

    const candidate = await this.extractSessionTitle(filePath, parsed.sessionId)
      // history.jsonl only ever carries the prompt text the user typed.
      ?? this.historyCandidate(nameMap.get(parsed.sessionId));

    // Keep the stored name unless the transcript now offers one of equal or
    // better provenance — this is what lets the CLI's generated title replace
    // the first-message placeholder once it appears, a few turns in.
    const keepExisting = hasRealExistingName
      && (!candidate || !shouldReplaceSessionName(existingSession?.name_source, candidate.source));

    if (keepExisting) {
      return {
        ...parsed,
        sessionName: normalizeSessionName(existingSessionName ?? undefined, PLACEHOLDER_NAME),
        nameSource: (existingSession?.name_source as SessionNameSource | undefined) ?? 'derived',
      };
    }

    return {
      ...parsed,
      sessionName: normalizeSessionName(candidate?.name, PLACEHOLDER_NAME),
      nameSource: candidate?.source ?? 'derived',
    };
  }

  private historyCandidate(display: string | undefined): TitleCandidate | null {
    return display?.trim() ? { name: display, source: 'derived' } : null;
  }

  /**
   * Reads the transcript back-to-front and returns the best title event in it.
   * Scanning backwards means the newest of each kind wins; ranking across kinds
   * means a generated title beats any prompt, however recent.
   */
  private async extractSessionTitle(
    filePath: string,
    sessionId: string
  ): Promise<TitleCandidate | null> {
    let found = new Map<string, string>();

    try {
      const { size } = await stat(filePath);
      const cached = titleScanCache.get(filePath);
      // A shrunken file is a rewrite (a rewind truncates the transcript), so
      // the remembered tail no longer describes it — start over.
      const resumable = Boolean(cached && cached.sessionId === sessionId && size >= cached.consumedBytes);
      const offset = resumable ? cached!.consumedBytes : 0;
      if (resumable) {
        found = new Map(cached!.found);
      }

      if (size > offset) {
        const chunk = await readByteRange(filePath, offset, size - offset);
        // The CLI may be halfway through writing the last record. Stop at the
        // final newline and leave the rest for the next event, so the resume
        // point is always a record boundary (and never splits a UTF-8 char).
        const lastNewline = chunk.lastIndexOf(0x0a);
        if (lastNewline >= 0) {
          const complete = chunk.subarray(0, lastNewline + 1);
          collectTitleEvents(complete.toString('utf8'), sessionId, found);

          if (titleScanCache.size >= TITLE_SCAN_CACHE_LIMIT && !titleScanCache.has(filePath)) {
            titleScanCache.clear();
          }
          titleScanCache.set(filePath, {
            sessionId,
            consumedBytes: offset + lastNewline + 1,
            found: new Map(found),
          });
        }
      }
    } catch {
      // Ignore missing/unreadable files so sync can continue.
      titleScanCache.delete(filePath);
    }

    for (const event of TITLE_EVENTS) {
      const name = found.get(event.type);
      if (name) {
        return { name, source: event.source };
      }
    }

    return null;
  }
}

/** Reads `length` bytes from `offset` without pulling the whole file in. */
async function readByteRange(filePath: string, offset: number, length: number): Promise<Buffer> {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Folds one newly appended slice of a transcript into `found`.
 *
 * Scanning backwards means the newest event of each type in this slice wins,
 * and because the slice is newer than everything already in `found`, it also
 * outranks what a previous pass recorded for the same type.
 */
function collectTitleEvents(text: string, sessionId: string, found: Map<string, string>): void {
  const lines = text.split(/\r?\n/);
  const seenHere = new Set<string>();

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    const data = parsed as Record<string, unknown>;
    if (data.sessionId !== sessionId || typeof data.type !== 'string') {
      continue;
    }

    const event = TITLE_EVENTS.find((entry) => entry.type === data.type);
    if (!event || seenHere.has(event.type)) {
      continue;
    }

    const value = data[event.field];
    if (typeof value === 'string' && value.trim()) {
      seenHere.add(event.type);
      found.set(event.type, value);
      // The best-ranked event shadows the others for good — a later slice
      // carrying only a `last-prompt` still loses to it — so there is nothing
      // left to learn from the rest of this slice.
      if (event.type === TITLE_EVENTS[0].type || seenHere.size === TITLE_EVENTS.length) {
        break;
      }
    }
  }
}
