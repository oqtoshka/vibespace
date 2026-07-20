import type { ClaudeSettings } from '../types/types';

export const CLAUDE_SETTINGS_KEY = 'claude-settings';

export const safeLocalStorage = {
  setItem: (key: string, value: string) => {
    try {
      localStorage.setItem(key, value);
    } catch (error: any) {
      if (error?.name === 'QuotaExceededError') {
        console.warn('localStorage quota exceeded, clearing old data');

        const keys = Object.keys(localStorage);
        const draftKeys = keys.filter((k) => k.startsWith('draft_input_') || k.startsWith('queued_message_'));
        draftKeys.forEach((k) => {
          localStorage.removeItem(k);
        });

        try {
          localStorage.setItem(key, value);
        } catch (retryError) {
          console.error('Failed to save to localStorage even after cleanup:', retryError);
        }
      } else {
        console.error('localStorage error:', error);
      }
    }
  },
  getItem: (key: string): string | null => {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      console.error('localStorage getItem error:', error);
      return null;
    }
  },
  removeItem: (key: string) => {
    try {
      localStorage.removeItem(key);
    } catch (error) {
      console.error('localStorage removeItem error:', error);
    }
  },
};

/**
 * Composer options captured when a message is queued, so the message can be
 * sent later with the exact settings (model, permission mode, tools) the
 * session's composer had at queue time — even from outside the composer,
 * e.g. the app-level auto-send that fires while another session is viewed.
 */
export type QueuedSendOptions = Record<string, unknown>;

export type StoredQueuedMessage = {
  content: string;
  options?: QueuedSendOptions;
};

export const queuedMessageKey = (sessionId: string) => `queued_message_${sessionId}`;

/**
 * Reads a session's queued message. Understands both the JSON
 * `{ content, options }` format and the legacy raw-text format.
 */
export function readQueuedMessage(sessionId: string): StoredQueuedMessage | null {
  const raw = safeLocalStorage.getItem(queuedMessageKey(sessionId));
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && typeof (parsed as StoredQueuedMessage).content === 'string') {
      const { content, options } = parsed as StoredQueuedMessage;
      return content.trim() ? { content, options } : null;
    }
  } catch {
    // Legacy format: the raw draft text itself.
  }

  return raw.trim() ? { content: raw } : null;
}

export function writeQueuedMessage(sessionId: string, message: StoredQueuedMessage): void {
  safeLocalStorage.setItem(queuedMessageKey(sessionId), JSON.stringify(message));
}

export function clearQueuedMessage(sessionId: string): void {
  safeLocalStorage.removeItem(queuedMessageKey(sessionId));
}

/**
 * Journal of sends dispatched over the websocket but not yet evidenced by the
 * server. The composer clears its input the moment a message is dispatched, so
 * a frame fired into a dead socket (backgrounded mobile tab, sleeping laptop,
 * reconnect window) would otherwise vanish without a trace. Entries survive
 * page reloads and are removed only when server state proves receipt — a
 * queue snapshot containing the item id for queued sends (`kind: 'queue'`),
 * or live run events for direct sends (`kind: 'send'`). Stale unacked entries
 * are restored into the composer input.
 */
export type PendingSendKind = 'send' | 'queue';

export type PendingSend = {
  id: string;
  content: string;
  kind: PendingSendKind;
  ts: number;
};

const pendingSendsKey = (sessionId: string) => `pending_sends_${sessionId}`;
const PENDING_SEND_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PENDING_SENDS = 20;

export function readPendingSends(sessionId: string): PendingSend[] {
  const raw = safeLocalStorage.getItem(pendingSendsKey(sessionId));
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    const now = Date.now();
    return parsed.filter(
      (entry): entry is PendingSend =>
        Boolean(
          entry &&
            typeof (entry as PendingSend).id === 'string' &&
            typeof (entry as PendingSend).content === 'string' &&
            typeof (entry as PendingSend).ts === 'number',
        ) && now - (entry as PendingSend).ts < PENDING_SEND_TTL_MS,
    );
  } catch {
    return [];
  }
}

function writePendingSends(sessionId: string, entries: PendingSend[]): void {
  if (entries.length === 0) {
    safeLocalStorage.removeItem(pendingSendsKey(sessionId));
    return;
  }
  safeLocalStorage.setItem(
    pendingSendsKey(sessionId),
    JSON.stringify(entries.slice(-MAX_PENDING_SENDS)),
  );
}

export function addPendingSend(sessionId: string, entry: PendingSend): void {
  writePendingSends(sessionId, [...readPendingSends(sessionId), entry]);
}

export function removePendingSends(sessionId: string, ids: Iterable<string>): void {
  const drop = new Set(ids);
  if (drop.size === 0) {
    return;
  }
  writePendingSends(
    sessionId,
    readPendingSends(sessionId).filter((entry) => !drop.has(entry.id)),
  );
}

export function getClaudeSettings(): ClaudeSettings {
  const raw = safeLocalStorage.getItem(CLAUDE_SETTINGS_KEY);
  if (!raw) {
    return {
      allowedTools: [],
      disallowedTools: [],
      skipPermissions: false,
      projectSortOrder: 'date',
    };
  }

  try {
    const parsed = JSON.parse(raw);
    return {
      ...parsed,
      allowedTools: Array.isArray(parsed.allowedTools) ? parsed.allowedTools : [],
      disallowedTools: Array.isArray(parsed.disallowedTools) ? parsed.disallowedTools : [],
      skipPermissions: Boolean(parsed.skipPermissions),
      projectSortOrder: parsed.projectSortOrder || 'date',
    };
  } catch {
    return {
      allowedTools: [],
      disallowedTools: [],
      skipPermissions: false,
      projectSortOrder: 'date',
    };
  }
}
