import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

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
 * Session indexer for Claude transcript artifacts.
 */
export class ClaudeSessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'claude' as const;
  private readonly claudeHome = path.join(os.homedir(), '.claude');

  /**
   * Returns true when a JSONL file is a subagent transcript rather than a
   * top-level session.
   *
   * Claude stores subagent transcripts under a `subagents/` directory, e.g.
   * `~/.claude/projects/<encoded-cwd>/<session-id>/subagents/agent-<id>.jsonl`.
   * Those files repeat the parent session's `sessionId`, so indexing them as
   * standalone sessions overwrites the parent row's `jsonl_path` and corrupts
   * the main session record. The recursive scan in `synchronize()` reaches
   * them, so both entry points must skip them.
   */
  private isSubagentTranscript(filePath: string): boolean {
    return path.normalize(filePath).split(path.sep).includes('subagents');
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
    const found = new Map<string, string>();

    try {
      const content = await readFile(filePath, 'utf8');
      const lines = content.split(/\r?\n/);

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
        if (!event || found.has(event.type)) {
          continue;
        }

        const value = data[event.field];
        if (typeof value === 'string' && value.trim()) {
          found.set(event.type, value);
          // The best-ranked event is all we need; stop once it's in hand.
          if (event.type === TITLE_EVENTS[0].type) {
            break;
          }
        }
      }
    } catch {
      // Ignore missing/unreadable files so sync can continue.
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
