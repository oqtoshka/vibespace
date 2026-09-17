import { appConfigDb, sessionsDb } from '@/modules/database/index.js';
import { parseFilesInputTag, type FetchHistoryResult, type LLMProvider } from '@/shared/index.js';

type Receipt = { id: string; kind: 'text'; role: 'user'; content: string; timestamp: string;
  images: unknown[]; files: unknown[] };
const key = (sessionId: string) => `native_messages:${sessionId}`;
const read = (sessionId: string): Receipt[] => JSON.parse(appConfigDb.get(key(sessionId)) || '[]');

/** Native socket acknowledgements retain the prompt before a provider has a transcript.
 * Stop during startup must not erase a message that the server already accepted. */
export function retainNativeSend(sessionId: string, clientMsgId: string, content: string,
  options: { images?: unknown[]; files?: unknown[] } = {}): void {
  const receipts = read(sessionId);
  const id = `native-receipt-${clientMsgId}`;
  if (receipts.some(receipt => receipt.id === id)) return;
  receipts.push({ id, kind: 'text', role: 'user', content, timestamp: new Date().toISOString(),
    images: options.images ?? [], files: options.files ?? [] });
  appConfigDb.set(key(sessionId), JSON.stringify(receipts));
}

/** Bridge a missing provider transcript, never perturb provider pagination.
 * Once provider history exists it remains authoritative; confirmed receipts are retired.
 * The native client also retains its own receipt while that history catches up. */
export function nativeHistoryWithReceipts(sessionId: string, page: FetchHistoryResult): FetchHistoryResult {
  if ((page.offset ?? 0) !== 0) return page;
  const receipts = read(sessionId);
  if (!receipts.length) return page;
  const candidates = page.messages.filter(message => message.role === 'user');
  const remaining = receipts.filter(receipt => {
    const index = candidates.findIndex(message => {
      const timestamp = typeof message.timestamp === 'string' ? Date.parse(message.timestamp) : message.timestamp;
      return parseFilesInputTag(message.content ?? '').text.trim() === receipt.content.trim() && (timestamp == null ||
        (typeof timestamp === 'number' && timestamp >= Date.parse(receipt.timestamp) - 2000));
    });
    if (index < 0) return true;
    candidates.splice(index, 1); return false;
  });
  if (remaining.length !== receipts.length) appConfigDb.set(key(sessionId), JSON.stringify(remaining));
  if (!remaining.length) return page;
  if (page.messages.length > 0 || page.total > 0 || page.hasMore) return page;
  const provider = sessionsDb.getSessionById(sessionId)?.provider as LLMProvider;
  const messages = [...page.messages, ...remaining.map(receipt => ({ ...receipt, sessionId, provider }))];
  return { ...page, messages, total: (page.total ?? page.messages.length) + remaining.length };
}
