export type SessionMetadataChange = {
  sessionId: string;
  provider: string;
  providerSessionId: string | null;
  projectPath: string | null;
  transcriptPath: string | null;
  title: string;
  recap: string;
  isPrivate: boolean;
};

type SessionMetadataSubscriber = (change: SessionMetadataChange) => void;

const subscribers = new Set<SessionMetadataSubscriber>();
const lastPublishedMetadata = new Map<string, string>();

/**
 * Registers a host-plugin listener for session title/recap changes.
 *
 * The plugin host consumes this to let optional external integrations mirror
 * VibeSpace-owned metadata without coupling provider services to those tools.
 */
export function subscribeSessionMetadataChanges(subscriber: SessionMetadataSubscriber): () => void {
  subscribers.add(subscriber);
  return () => subscribers.delete(subscriber);
}

/**
 * Publishes the latest metadata observed by the provider session watcher.
 *
 * The Providers module calls this on every session upsert; value deduplication
 * makes transcript-only changes free while still announcing provider-id,
 * title, recap, archive/privacy, or path changes exactly once per process.
 */
export function publishSessionMetadataChange(change: SessionMetadataChange): void {
  const signature = JSON.stringify([
    change.providerSessionId,
    change.projectPath,
    change.transcriptPath,
    change.title,
    change.recap,
    change.isPrivate,
  ]);
  if (lastPublishedMetadata.get(change.sessionId) === signature) return;
  lastPublishedMetadata.set(change.sessionId, signature);

  for (const subscriber of subscribers) {
    try {
      subscriber(change);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[Plugins] Session metadata subscriber failed: ${message}`);
    }
  }
}

/** Test-only reset for process-global subscribers and deduplication state. */
export function resetSessionMetadataEventsForTests(): void {
  subscribers.clear();
  lastPublishedMetadata.clear();
}
