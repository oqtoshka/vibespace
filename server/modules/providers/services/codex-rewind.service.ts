import type { AnyRecord } from '@/shared/index.js';

/** The Codex runtime calls this on its own loaded app-server before starting an edited turn. */
export async function rewindCodexTurn(
  request: (method: string, params: AnyRecord) => Promise<AnyRecord>,
  threadId: string,
  anchor: string,
  beforePaginatedRevert: () => void = () => {},
): Promise<'legacy' | 'paginated'> {
  if (!/^codex-turn-[a-zA-Z0-9_-]+$/.test(anchor)) throw new Error('Invalid Codex edit anchor. Reload the conversation.');
  const { thread } = await request('thread/read', { threadId, includeTurns: false });
  if (thread?.id !== threadId) throw new Error('Could not verify Codex history. Reload the conversation.');
  if (thread.status?.type === 'active') throw new Error('Stop the response before editing.');
  const beforeTurnId = anchor.slice('codex-turn-'.length);
  if (thread.historyMode === 'paginated') {
    // The provider validates the anchor and idle state atomically. Revert keeps
    // the thread ID but replaces its durable rollout; counting hydrated turns
    // and calling legacy rollback is not supported for this storage format.
    beforePaginatedRevert();
    await request('thread/revert', { threadId, beforeTurnId });
    return 'paginated';
  }
  if (thread.historyMode && thread.historyMode !== 'legacy') throw new Error('Unknown Codex history format. Update VibeSpace before editing.');
  const full = await request('thread/read', { threadId, includeTurns: true });
  if (full.thread?.id !== threadId || !Array.isArray(full.thread.turns)) throw new Error('Could not verify Codex history. Reload the conversation.');
  const turns = full.thread.turns as AnyRecord[];
  if (full.thread.status?.type === 'active' || turns.some(turn => turn.status === 'inProgress')) throw new Error('Stop the response before editing.');
  const index = turns.findIndex(turn => turn.id === beforeTurnId);
  if (index < 0) throw new Error('This message is no longer in Codex history. Reload the conversation.');
  await request('thread/rollback', { threadId, numTurns: turns.length - index });
  return 'legacy';
}
