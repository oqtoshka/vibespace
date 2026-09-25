/**
 * Per-session replay position for the chat websocket.
 *
 * The server numbers live events per run: every run starts again at `seq` 1
 * and tags its events with a `runId`. A `chat.subscribe` (session open, socket
 * reconnect, tab refocus while a run is live) replays the running run's events
 * after the `lastSeq` it names. Two things follow:
 *
 * - The client must drop a replayed event it already applied. Most kinds are
 *   upserted by id, but `stream_delta` text is appended, so a second copy of a
 *   delta doubled the reply on screen until a refresh reloaded history.
 * - A position is only meaningful inside its run. Carrying `lastSeq` 50 from
 *   the previous run into a new one made the server skip that run's first 50
 *   events on a resubscribe, or replay events the client had already shown.
 */
export type ReplayCursor = {
  runId: string | null;
  seq: number;
};

export type ReplayCursorMap = Map<string, ReplayCursor>;

/** The `chat.subscribe` fields for one session. */
export function replayPosition(cursors: ReplayCursorMap, sessionId: string): { lastSeq: number; runId?: string } {
  const cursor = cursors.get(sessionId);
  if (!cursor) {
    return { lastSeq: 0 };
  }
  return cursor.runId ? { lastSeq: cursor.seq, runId: cursor.runId } : { lastSeq: cursor.seq };
}

/**
 * Records a sequenced live event and reports whether it is new.
 *
 * Returns `false` only for an event of the same run at or below the recorded
 * position — a replay of something already applied. Events without a `runId`
 * (an older server) are always applied, since their position cannot be told
 * apart from a new run's.
 */
export function acceptSequencedEvent(
  cursors: ReplayCursorMap,
  sessionId: string,
  seq: number,
  runId: string | null,
): boolean {
  const cursor = cursors.get(sessionId);

  if (!runId) {
    if (!cursor || seq > cursor.seq) {
      cursors.set(sessionId, { runId: cursor?.runId ?? null, seq });
    }
    return true;
  }

  if (!cursor || cursor.runId !== runId) {
    cursors.set(sessionId, { runId, seq });
    return true;
  }

  if (seq <= cursor.seq) {
    return false;
  }
  cursor.seq = seq;
  return true;
}
