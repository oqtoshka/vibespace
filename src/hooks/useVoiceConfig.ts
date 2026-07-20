import { useEffect, useRef, useState } from 'react';

import { authenticatedFetch } from '../utils/api';

// Voice settings live on the user record (see /api/user/voice-settings) so they
// roam across browsers and devices. The raw API key never reaches the client:
// the server returns a set-flag + masked hint, and typing a new key replaces
// the stored one (blank / masked input leaves it untouched).
export type VoiceSettings = {
  sttModel: string;
  ttsModel: string;
  ttsVoice: string;
  ttsFormat: string;
  apiKeySet: boolean;
  apiKeyHint: string;
};

export const VOICE_CONFIG_SYNC_EVENT = 'voice-config:sync';

// Pre-server-storage localStorage blob; migrated up once, then removed.
const LEGACY_STORAGE_KEY = 'voiceConfig';

const DEFAULTS: VoiceSettings = {
  sttModel: '',
  ttsModel: '',
  ttsVoice: '',
  ttsFormat: '',
  apiKeySet: false,
  apiKeyHint: '',
};

const SAVE_DEBOUNCE_MS = 800;

let cachedSettings: VoiceSettings | null = null;
let loadRequest: Promise<VoiceSettings> | null = null;

function normalizeClientSettings(value: unknown): VoiceSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULTS };
  const source = value as Record<string, unknown>;
  return {
    sttModel: typeof source.sttModel === 'string' ? source.sttModel : '',
    ttsModel: typeof source.ttsModel === 'string' ? source.ttsModel : '',
    ttsVoice: typeof source.ttsVoice === 'string' ? source.ttsVoice : '',
    ttsFormat: typeof source.ttsFormat === 'string' ? source.ttsFormat : '',
    apiKeySet: source.apiKeySet === true,
    apiKeyHint: typeof source.apiKeyHint === 'string' ? source.apiKeyHint : '',
  };
}

function publish(settings: VoiceSettings): VoiceSettings {
  cachedSettings = settings;
  window.dispatchEvent(new Event(VOICE_CONFIG_SYNC_EVENT));
  return settings;
}

async function saveVoiceSettings(payload: Record<string, unknown>): Promise<VoiceSettings> {
  const response = await authenticatedFetch('/api/user/voice-settings', {
    method: 'PUT',
    body: JSON.stringify({ settings: payload }),
  });
  if (!response.ok) throw new Error(`Failed to save voice settings (${response.status})`);
  const data = await response.json();
  return publish(normalizeClientSettings(data?.settings));
}

/**
 * One-time migration of the legacy localStorage blob to the server: only runs
 * when the server has nothing stored yet, and removes the local copy (which
 * held the API key in plain text) once the server owns the settings.
 */
async function migrateLegacyLocalSettings(server: VoiceSettings): Promise<VoiceSettings> {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(LEGACY_STORAGE_KEY);
  } catch {
    return server;
  }
  if (!raw) return server;

  const serverEmpty =
    !server.apiKeySet && !server.sttModel && !server.ttsModel && !server.ttsVoice && !server.ttsFormat;
  let migrated = server;
  if (serverEmpty) {
    try {
      const local = JSON.parse(raw) as Record<string, unknown>;
      const payload = {
        apiKey: typeof local?.apiKey === 'string' ? local.apiKey : '',
        sttModel: typeof local?.sttModel === 'string' ? local.sttModel : '',
        ttsModel: typeof local?.ttsModel === 'string' ? local.ttsModel : '',
        ttsVoice: typeof local?.ttsVoice === 'string' ? local.ttsVoice : '',
        ttsFormat: typeof local?.ttsFormat === 'string' ? local.ttsFormat : '',
      };
      if (Object.values(payload).some((v) => v.trim() !== '')) {
        migrated = await saveVoiceSettings(payload);
      }
    } catch {
      return server;
    }
  }
  try {
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    /* ignore */
  }
  return migrated;
}

export function loadVoiceSettings(): Promise<VoiceSettings> {
  if (cachedSettings) return Promise.resolve(cachedSettings);
  if (loadRequest) return loadRequest;
  loadRequest = authenticatedFetch('/api/user/voice-settings')
    .then(async (response) => {
      if (!response.ok) throw new Error(`Failed to load voice settings (${response.status})`);
      const data = await response.json();
      return migrateLegacyLocalSettings(normalizeClientSettings(data?.settings));
    })
    .then(publish)
    .catch(() => publish({ ...DEFAULTS }))
    .finally(() => {
      loadRequest = null;
    });
  return loadRequest;
}

/**
 * Cache key input for generated TTS audio: the settings that affect the sound.
 * Synchronous by design (callers hash it per message render); before the first
 * load resolves it falls back to defaults, which at worst regenerates audio.
 */
export function voiceConfigSignature(): string {
  const s = cachedSettings ?? DEFAULTS;
  return JSON.stringify([s.ttsModel, s.ttsVoice, s.ttsFormat]);
}

export function useVoiceConfig() {
  const [config, setConfig] = useState<VoiceSettings>(() => cachedSettings ?? { ...DEFAULTS });
  const [saveError, setSaveError] = useState(false);
  // The key input is write-only: it buffers what the user types until it is
  // saved, then clears back to the masked placeholder.
  const [apiKeyInput, setApiKeyInput] = useState('');
  const pendingRef = useRef<Record<string, unknown>>({});
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let active = true;
    void loadVoiceSettings().then((settings) => {
      if (active) setConfig(settings);
    });
    const sync = () => {
      if (active && cachedSettings) setConfig(cachedSettings);
    };
    window.addEventListener(VOICE_CONFIG_SYNC_EVENT, sync);
    return () => {
      active = false;
      window.removeEventListener(VOICE_CONFIG_SYNC_EVENT, sync);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const flush = () => {
    const payload = pendingRef.current;
    pendingRef.current = {};
    timerRef.current = null;
    saveVoiceSettings(payload)
      .then((settings) => {
        setConfig(settings);
        setSaveError(false);
        if (typeof payload.apiKey === 'string' && payload.apiKey.trim()) setApiKeyInput('');
      })
      .catch(() => setSaveError(true));
  };

  const update = (patch: Partial<VoiceSettings> & { apiKey?: string; clearApiKey?: boolean }) => {
    const { apiKey, clearApiKey, ...fields } = patch;
    if (typeof apiKey === 'string') setApiKeyInput(apiKey);
    setConfig((prev) => ({ ...prev, ...fields }));
    pendingRef.current = { ...pendingRef.current, ...fields };
    if (typeof apiKey === 'string') pendingRef.current.apiKey = apiKey;
    if (clearApiKey) pendingRef.current.clearApiKey = true;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(flush, SAVE_DEBOUNCE_MS);
  };

  return { config, apiKeyInput, update, saveError };
}
