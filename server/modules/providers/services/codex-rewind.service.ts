import type { AnyRecord } from '@/shared/index.js';

/** The Codex runtime calls this on its own loaded app-server before starting an edited turn. */
export async function rewindCodexTurn(
  request: (method: string, params: AnyRecord) => Promise<AnyRecord>,
  threadId: string,
  anchor: string,
): Promise<void> {
  if (!anchor.startsWith('codex-turn-')) throw new Error('Invalid Codex edit anchor. Reload the conversation.');
  const { thread } = await request('thread/read', { threadId, includeTurns: true });
  if (thread?.id !== threadId || !Array.isArray(thread.turns)) throw new Error('Could not verify Codex history. Reload the conversation.');
  const turns = thread.turns as AnyRecord[];
  if (thread.status?.type === 'active' || turns.some(turn => turn.status === 'inProgress')) {
    throw new Error('Stop the response before editing.');
  }
  const index = turns.findIndex(turn => turn.id === anchor.slice('codex-turn-'.length));
  if (index < 0) throw new Error('This message is no longer in Codex history. Reload the conversation.');
  // Never append the replacement if rollback fails. The same loaded thread
  // owns both the persisted rollback marker and the model's in-memory context.
  await request('thread/rollback', { threadId, numTurns: turns.length - index });
}
