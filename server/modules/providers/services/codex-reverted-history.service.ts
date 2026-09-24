import { appConfigDb } from '@/modules/database/index.js';
import type { AnyRecord } from '@/shared/index.js';

// Registration can occur during the legacy runtime/provider barrel import cycle.
// A hoisted declaration without an initializer preserves that early registration.
// eslint-disable-next-line no-var
var reader: ((threadId: string, isPrivate: boolean) => Promise<AnyRecord[]>) | undefined;

/** Legacy Codex runtime supplies its app-server transport without a providers-to-runtime import cycle. */
export function registerCodexRevertedHistoryReader(value: typeof reader): void { reader = value; }

/** The runtime selects canonical history before attempting revert, so crashes or index scans cannot restore an old rollout. */
export function markCodexRevertedHistory(threadId: string): void {
  appConfigDb.set(`codex_reverted_history:${threadId}`, '1');
}

/** The Codex history adapter reads canonical provider history after paginated history replacement. */
export async function readCodexRevertedHistory(threadId: string, isPrivate: boolean): Promise<AnyRecord[] | undefined> {
  if (appConfigDb.get(`codex_reverted_history:${threadId}`) !== '1') return undefined;
  if (!reader) throw new Error('Codex history transport is not available. Reconnect before continuing.');
  // Never fall back to the old JSONL: it still contains the discarded messages.
  return reader(threadId, isPrivate);
}
