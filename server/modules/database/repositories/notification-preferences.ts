/**
 * Notification preferences repository.
 *
 * Stores per-user notification channel/event preferences as JSON.
 */

import { getConnection } from '@/modules/database/connection.js';

type TelegramPreferences = {
  enabled: boolean;
  /** Bot API token. Stored server-side; never returned raw to the client. */
  botToken: string;
  chatId: string;
};

type NotificationPreferences = {
  channels: {
    inApp: boolean;
    webPush: boolean;
    sound: boolean;
  };
  events: {
    actionRequired: boolean;
    stop: boolean;
    error: boolean;
  };
  telegram: TelegramPreferences;
};

/**
 * Client-facing shape: the raw bot token is replaced by a "set" flag and a
 * masked hint so the secret never round-trips to the browser.
 */
export type ClientNotificationPreferences = Omit<NotificationPreferences, 'telegram'> & {
  telegram: {
    enabled: boolean;
    chatId: string;
    botTokenSet: boolean;
    botTokenHint: string;
  };
};

const DEFAULT_TELEGRAM_PREFERENCES: TelegramPreferences = {
  enabled: false,
  botToken: '',
  chatId: '',
};

const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  channels: {
    inApp: false,
    webPush: false,
    sound: true,
  },
  events: {
    actionRequired: true,
    stop: true,
    error: true,
  },
  telegram: { ...DEFAULT_TELEGRAM_PREFERENCES },
};

function normalizeTelegram(value: unknown, previous?: TelegramPreferences): TelegramPreferences {
  const prev = previous ?? DEFAULT_TELEGRAM_PREFERENCES;
  if (!value || typeof value !== 'object') {
    return { ...prev };
  }

  const source = value as Record<string, any>;
  const incomingToken = typeof source.botToken === 'string' ? source.botToken.trim() : '';
  // Blank or masked (•••) token means "leave the stored secret untouched".
  const keepStoredToken = !incomingToken || incomingToken.startsWith('•');
  const botToken = keepStoredToken ? prev.botToken : incomingToken;

  return {
    enabled: source.enabled === true,
    chatId: typeof source.chatId === 'string' ? source.chatId.trim() : prev.chatId,
    // Disabling/clearing the token implicitly happens when the client sends an
    // explicit empty token with clearBotToken set.
    botToken: source.clearBotToken === true ? '' : botToken,
  };
}

function normalizeNotificationPreferences(
  value: unknown,
  previous?: NotificationPreferences,
): NotificationPreferences {
  const source = value && typeof value === 'object' ? (value as Record<string, any>) : {};

  return {
    channels: {
      inApp: source.channels?.inApp === true,
      webPush: source.channels?.webPush === true,
      sound: source.channels?.sound !== false,
    },
    events: {
      actionRequired: source.events?.actionRequired !== false,
      stop: source.events?.stop !== false,
      error: source.events?.error !== false,
    },
    telegram: normalizeTelegram(source.telegram, previous?.telegram),
  };
}

/** Strips the raw bot token, exposing only a "set" flag + masked hint. */
export function toClientNotificationPreferences(
  prefs: NotificationPreferences,
): ClientNotificationPreferences {
  const token = prefs.telegram?.botToken || '';
  return {
    channels: prefs.channels,
    events: prefs.events,
    telegram: {
      enabled: prefs.telegram?.enabled === true,
      chatId: prefs.telegram?.chatId || '',
      botTokenSet: Boolean(token),
      botTokenHint: token ? `••••${token.slice(-4)}` : '',
    },
  };
}

export const notificationPreferencesDb = {
  /** Returns the normalized preferences for a user, creating defaults on first read. */
  getNotificationPreferences(userId: number): NotificationPreferences {
    const db = getConnection();
    const row = db
      .prepare(
        'SELECT preferences_json FROM user_notification_preferences WHERE user_id = ?'
      )
      .get(userId) as { preferences_json: string } | undefined;

    if (!row) {
      const defaults = normalizeNotificationPreferences(DEFAULT_NOTIFICATION_PREFERENCES);
      db.prepare(
        'INSERT INTO user_notification_preferences (user_id, preferences_json, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)'
      ).run(userId, JSON.stringify(defaults));
      return defaults;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(row.preferences_json);
    } catch {
      parsed = DEFAULT_NOTIFICATION_PREFERENCES;
    }
    return normalizeNotificationPreferences(parsed);
  },

  /** Upserts normalized preferences for a user and returns the stored value. */
  updateNotificationPreferences(
    userId: number,
    preferences: unknown
  ): NotificationPreferences {
    // Merge against the currently-stored prefs so a blank/masked telegram token
    // in the incoming payload preserves the existing secret rather than wiping it.
    const existing = notificationPreferencesDb.getNotificationPreferences(userId);
    const normalized = normalizeNotificationPreferences(preferences, existing);
    const db = getConnection();

    db.prepare(
      `INSERT INTO user_notification_preferences (user_id, preferences_json, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id) DO UPDATE SET
         preferences_json = excluded.preferences_json,
         updated_at = CURRENT_TIMESTAMP`
    ).run(userId, JSON.stringify(normalized));

    return normalized;
  },

  // Legacy aliases used by existing services/routes
  getPreferences(userId: number): NotificationPreferences {
    return notificationPreferencesDb.getNotificationPreferences(userId);
  },
  updatePreferences(userId: number, preferences: unknown): NotificationPreferences {
    return notificationPreferencesDb.updateNotificationPreferences(userId, preferences);
  },
};

