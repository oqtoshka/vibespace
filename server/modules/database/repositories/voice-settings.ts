/**
 * Voice settings repository.
 *
 * Stores each user's STT/TTS backend settings (API key + model names) as JSON,
 * so voice works across browsers and devices without re-entering the key.
 * The backend base URL is intentionally NOT stored here — the voice proxy only
 * ever talks to the server-configured VOICE_API_BASE_URL (SSRF hardening).
 */

import { getConnection } from '@/modules/database/connection.js';

export type VoiceSettings = {
  /** Backend API key. Stored server-side; never returned raw to the client. */
  apiKey: string;
  sttModel: string;
  ttsModel: string;
  ttsVoice: string;
  ttsFormat: string;
};

/**
 * Client-facing shape: the raw API key is replaced by a "set" flag and a
 * masked hint so the secret never round-trips to the browser.
 */
export type ClientVoiceSettings = Omit<VoiceSettings, 'apiKey'> & {
  apiKeySet: boolean;
  apiKeyHint: string;
};

const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  apiKey: '',
  sttModel: '',
  ttsModel: '',
  ttsVoice: '',
  ttsFormat: '',
};

function normalizeVoiceSettings(value: unknown, previous?: VoiceSettings): VoiceSettings {
  const prev = previous ?? DEFAULT_VOICE_SETTINGS;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...prev };
  }

  const source = value as Record<string, any>;
  const readString = (key: keyof VoiceSettings): string =>
    typeof source[key] === 'string' ? source[key].trim() : prev[key];

  const incomingKey = typeof source.apiKey === 'string' ? source.apiKey.trim() : '';
  // Blank or masked (•••) key means "leave the stored secret untouched".
  const keepStoredKey = !incomingKey || incomingKey.startsWith('•');

  return {
    apiKey: source.clearApiKey === true ? '' : keepStoredKey ? prev.apiKey : incomingKey,
    sttModel: readString('sttModel'),
    ttsModel: readString('ttsModel'),
    ttsVoice: readString('ttsVoice'),
    ttsFormat: readString('ttsFormat'),
  };
}

/** Strips the raw API key, exposing only a "set" flag + masked hint. */
export function toClientVoiceSettings(settings: VoiceSettings): ClientVoiceSettings {
  const key = settings.apiKey || '';
  return {
    sttModel: settings.sttModel,
    ttsModel: settings.ttsModel,
    ttsVoice: settings.ttsVoice,
    ttsFormat: settings.ttsFormat,
    apiKeySet: Boolean(key),
    apiKeyHint: key ? `••••${key.slice(-4)}` : '',
  };
}

export const voiceSettingsDb = {
  /** Returns the normalized voice settings for a user (defaults when unset). */
  getVoiceSettings(userId: number): VoiceSettings {
    const db = getConnection();
    const row = db
      .prepare('SELECT settings_json FROM user_voice_settings WHERE user_id = ?')
      .get(userId) as { settings_json: string } | undefined;

    if (!row) {
      return { ...DEFAULT_VOICE_SETTINGS };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(row.settings_json);
    } catch {
      parsed = DEFAULT_VOICE_SETTINGS;
    }
    return normalizeVoiceSettings(parsed);
  },

  /** Upserts normalized voice settings for a user and returns the stored value. */
  updateVoiceSettings(userId: number, settings: unknown): VoiceSettings {
    // Merge against the currently-stored settings so a blank/masked API key in
    // the incoming payload preserves the existing secret rather than wiping it.
    const existing = voiceSettingsDb.getVoiceSettings(userId);
    const normalized = normalizeVoiceSettings(settings, existing);
    const db = getConnection();

    db.prepare(
      `INSERT INTO user_voice_settings (user_id, settings_json, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id) DO UPDATE SET
         settings_json = excluded.settings_json,
         updated_at = CURRENT_TIMESTAMP`
    ).run(userId, JSON.stringify(normalized));

    return normalized;
  },
};
