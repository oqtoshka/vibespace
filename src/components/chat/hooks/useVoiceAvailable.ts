import { useEffect, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import { VOICE_CONFIG_SYNC_EVENT } from '../../../hooks/useVoiceConfig';

// Voice UI is gated on the `voiceEnabled` UI preference (toggled in Quick Settings /
// the Settings modal) and a configured voice backend.
// Preferences live under the versioned key (see useUiPreferences); the legacy
// blob is only consulted when the versioned one hasn't been written yet.
const STORAGE_KEYS = ['uiPreferences.v2', 'uiPreferences'];
const SYNC_EVENT = 'ui-preferences:sync';
let healthRequest: Promise<VoiceHealth> | null = null;

export type VoicePreset = {
  id: string;
  label: string;
  sttModel: string;
  isDefault: boolean;
};

type VoiceHealth = {
  configured: boolean;
  defaultPresetId: string | null;
  presets: VoicePreset[];
};

const EMPTY_HEALTH: VoiceHealth = {
  configured: false,
  defaultPresetId: null,
  presets: [],
};

function normalizeVoiceHealth(value: unknown): VoiceHealth {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return EMPTY_HEALTH;
  }

  const source = value as Record<string, unknown>;
  const presets = Array.isArray(source.presets)
    ? source.presets.flatMap((value): VoicePreset[] => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
        const preset = value as Record<string, unknown>;
        if (typeof preset.id !== 'string' || typeof preset.label !== 'string') return [];
        return [{
          id: preset.id,
          label: preset.label,
          sttModel: typeof preset.sttModel === 'string' ? preset.sttModel : '',
          isDefault: preset.isDefault === true,
        }];
      })
    : [];

  return {
    configured: source.configured === true,
    defaultPresetId: typeof source.defaultPresetId === 'string' ? source.defaultPresetId : null,
    presets,
  };
}

function checkVoiceHealth(): Promise<VoiceHealth> {
  if (healthRequest) return healthRequest;
  const request = authenticatedFetch('/api/voice/health')
    .then(async (response) => {
      if (!response.ok) throw new Error(`Voice health check failed (${response.status})`);
      const data = await response.json();
      return normalizeVoiceHealth(data);
    })
    .finally(() => {
      healthRequest = null;
    });
  healthRequest = request;
  return request;
}

function readVoiceEnabled(): boolean {
  for (const key of STORAGE_KEYS) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      return parsed?.voiceEnabled === true || parsed?.voiceEnabled === 'true';
    } catch {
      return false;
    }
  }
  return false;
}

export function useVoiceAvailable(): VoiceHealth & { available: boolean } {
  const [enabled, setEnabled] = useState<boolean>(() =>
    typeof window === 'undefined' ? false : readVoiceEnabled(),
  );
  const [health, setHealth] = useState<VoiceHealth>(EMPTY_HEALTH);

  useEffect(() => {
    const update = () => setEnabled(readVoiceEnabled());
    window.addEventListener('storage', update);
    window.addEventListener(SYNC_EVENT, update as EventListener);
    return () => {
      window.removeEventListener('storage', update);
      window.removeEventListener(SYNC_EVENT, update as EventListener);
    };
  }, []);

  useEffect(() => {
    let active = true;
    let requestId = 0;

    const check = async () => {
      if (!enabled) {
        setHealth(EMPTY_HEALTH);
        return;
      }
      const id = ++requestId;
      try {
        const result = await checkVoiceHealth();
        if (active && id === requestId) setHealth(result);
      } catch {
        if (active && id === requestId) setHealth(EMPTY_HEALTH);
      }
    };

    void check();
    window.addEventListener(VOICE_CONFIG_SYNC_EVENT, check);
    return () => {
      active = false;
      window.removeEventListener(VOICE_CONFIG_SYNC_EVENT, check);
    };
  }, [enabled]);

  return { ...health, available: enabled && health.configured };
}
