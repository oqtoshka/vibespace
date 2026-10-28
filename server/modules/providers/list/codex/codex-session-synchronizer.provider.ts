import os from 'node:os';
import { stat } from 'node:fs/promises';
import path from 'node:path';

import { sessionsDb } from '@/modules/database/index.js';
import {
  buildLookupMap,
  extractFirstValidJsonlData,
  findFilesRecursivelyCreatedAfter,
  normalizeSessionName,
  readFileTimestamps,
  stripLaunchInstructions,
} from '@/shared/utils.js';
import type { SessionNameSource } from '@/shared/utils.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';

import { extractCodexTextContent, isVisibleCodexUserMessage } from './codex-sessions.provider.js';

type ParsedSession = {
  sessionId: string;
  projectPath: string;
  sessionName?: string;
  /** Provenance of sessionName; undefined keeps the stored one. */
  nameSource?: SessionNameSource;
  isBackground: boolean;
};

/**
 * Session indexer for Codex transcript artifacts.
 */
export class CodexSessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'codex' as const;
  private readonly codexHome = path.join(os.homedir(), '.codex');
  private historyStamp = '';
  private interactiveIds = new Set<string>();

  // The TUI's submitted-prompt journal is explicit interaction evidence; exec
  // continuations alone never promote a run. Read only when its fingerprint changes.
  private async refreshInteractiveHistory(): Promise<void> {
    const historyPath = path.join(this.codexHome, 'history.jsonl');
    try {
      const info = await stat(historyPath);
      const stamp = `${info.ino}:${info.size}:${info.mtimeMs}`;
      if (stamp === this.historyStamp) return;
      const entries = await buildLookupMap(historyPath, 'session_id', 'text');
      this.interactiveIds = new Set(entries.keys());
      for (const id of this.interactiveIds) sessionsDb.promoteBackgroundSession(id);
      this.historyStamp = stamp;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private indexBackground(sessionId: string, parsed: ParsedSession): void {
    sessionsDb.setSessionBackground(sessionId, parsed.isBackground);
    if (this.interactiveIds.has(parsed.sessionId)) sessionsDb.promoteBackgroundSession(sessionId);
  }

  /**
   * Scans ~/.codex/sessions and upserts discovered sessions into DB.
   */
  async synchronize(since?: Date): Promise<number> {
    await this.refreshInteractiveHistory();
    const nameMap = await buildLookupMap(path.join(this.codexHome, 'session_index.jsonl'), 'id', 'thread_name');
    const files = await findFilesRecursivelyCreatedAfter(
      path.join(this.codexHome, 'sessions'),
      '.jsonl',
      since ?? null
    );

    let processed = 0;
    for (const filePath of files) {
      const parsed = await this.processSessionFile(filePath, nameMap);
      if (!parsed) {
        continue;
      }

      const existingSession = sessionsDb.getSessionByProviderSessionId(parsed.sessionId)
        ?? sessionsDb.getSessionById(parsed.sessionId);
      if (existingSession) {
        // If session name is untitled and we now have a name, update it
        if (existingSession.custom_name === 'Untitled Codex Session' && parsed.sessionName && parsed.sessionName !== 'Untitled Codex Session') {
          sessionsDb.updateSessionCustomName(existingSession.session_id, parsed.sessionName, 'derived');
        }
      }

      const timestamps = await readFileTimestamps(filePath);
      const sessionId = sessionsDb.createSession(
        parsed.sessionId,
        this.provider,
        parsed.projectPath,
        parsed.sessionName,
        timestamps.createdAt,
        timestamps.updatedAt,
        filePath,
        parsed.nameSource
      );
      this.indexBackground(sessionId, parsed);
      processed += 1;
    }

    return processed;
  }

  /**
   * Parses and upserts one Codex session JSONL file.
   */
  async synchronizeFile(filePath: string): Promise<string | null> {
    if (!filePath.endsWith('.jsonl')) {
      return null;
    }

    await this.refreshInteractiveHistory();
    const nameMap = await buildLookupMap(path.join(this.codexHome, 'session_index.jsonl'), 'id', 'thread_name');
    const parsed = await this.processSessionFile(filePath, nameMap);
    if (!parsed) {
      return null;
    }

    const timestamps = await readFileTimestamps(filePath);
    const sessionId = sessionsDb.createSession(
      parsed.sessionId,
      this.provider,
      parsed.projectPath,
      parsed.sessionName,
      timestamps.createdAt,
      timestamps.updatedAt,
      filePath,
      parsed.nameSource
    );
    this.indexBackground(sessionId, parsed);
    return sessionId;
  }

  /**
   * Extracts session metadata from one Codex JSONL session file.
   */
  private async processSessionFile(
    filePath: string,
    nameMap: Map<string, string>
  ): Promise<ParsedSession | null> {
    const parsed = await extractFirstValidJsonlData(filePath, (rawData) => {
      const data = rawData as Record<string, unknown>;
      if (data.type !== 'session_meta') return null;
      const payload = data.payload as Record<string, unknown> | undefined;
      const sessionId = typeof payload?.id === 'string' ? payload.id : undefined;
      const projectPath = typeof payload?.cwd === 'string' ? payload.cwd : undefined;

      if (!sessionId || !projectPath) {
        return null;
      }

      return {
        sessionId,
        projectPath,
        isBackground: payload?.originator === 'codex_exec' || payload?.source === 'exec',
        isSubagent: payload ? this.isSubagentSessionMeta(payload) : false,
      };
    });

    if (!parsed || parsed.isSubagent) {
      return null;
    }

    // App-created sessions are keyed by an app id, so disk-discovered provider
    // ids must be resolved through the provider-id mapping first.
    const existingSession = sessionsDb.getSessionByProviderSessionId(parsed.sessionId)
      ?? sessionsDb.getSessionById(parsed.sessionId);
    const existingSessionName = existingSession?.custom_name;
    const threadName = nameMap.get(parsed.sessionId);
    // A stored name stands unless it is a placeholder: the untitled fallback,
    // or a first prompt once Codex has named the thread.
    const isPlaceholder = existingSessionName === 'Untitled Codex Session'
      || (Boolean(threadName) && existingSession?.name_source === 'derived');
    if (existingSessionName && !isPlaceholder) {
      return {
        ...parsed,
        sessionName: normalizeSessionName(existingSessionName, 'Untitled Codex Session'),
      };
    }

    // Codex's own thread title, as the Claude synchronizer ranks the CLI's.
    if (threadName) {
      return { ...parsed, sessionName: normalizeSessionName(threadName, 'Untitled Codex Session'), nameSource: 'ai' };
    }

    // A session Codex never named (every `codex exec` run) shows the first
    // words its user wrote, a placeholder an AI title may replace, like the
    // untitled fallback. Never the assistant's last answer: that named
    // sessions after the agent's own closing sentence.
    return {
      ...parsed,
      sessionName: normalizeSessionName(await this.extractFirstUserPrompt(filePath), 'Untitled Codex Session'),
      nameSource: 'derived',
    };
  }

  /**
   * Returns true when a session_meta payload belongs to a Codex sub-agent
   * thread (Codex >=0.144 collaboration spawn_agent, review, compact, etc.).
   * Sub-agent rollouts live in the same sessions tree as user sessions, so
   * they must be skipped here to stay out of the sidebar — the Codex
   * equivalent of the Claude synchronizer's subagent transcript skip.
   * Top-level sessions carry thread_source "user" and a string source
   * ("exec"/"cli"); sub-agents carry thread_source "subagent" and an object
   * source keyed by "subagent".
   */
  private isSubagentSessionMeta(payload: Record<string, unknown>): boolean {
    if (payload.thread_source === 'subagent') {
      return true;
    }

    const source = payload.source;
    return typeof source === 'object' && source !== null && 'subagent' in source;
  }

  /**
   * The first message the user sent, without the launch instructions a
   * runtime put ahead of it; undefined when that message holds no words of
   * the user's own. Later messages never stand in for it.
   */
  private async extractFirstUserPrompt(filePath: string): Promise<string | undefined> {
    const firstMessage = await extractFirstValidJsonlData(filePath, (rawData) => {
      const data = rawData as Record<string, unknown>;
      const payload = data.payload as Record<string, unknown> | undefined;
      if (data.type !== 'event_msg' || !payload) {
        return null;
      }

      if (isVisibleCodexUserMessage(payload)) {
        return { text: payload.message as string };
      }

      // Current Codex records the prompt as a completed UserMessage item
      // instead of the legacy user_message event.
      const item = payload.item as Record<string, unknown> | undefined;
      if (payload.type === 'item_completed' && item?.type === 'UserMessage') {
        return { text: extractCodexTextContent(item.content) };
      }

      return null;
    });

    return stripLaunchInstructions(firstMessage?.text ?? '').trim() || undefined;
  }
}
