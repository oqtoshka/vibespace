import multer from 'multer';

import { voiceSettingsDb } from '@/modules/database/index.js';
import type { VoiceTranscriptionPresetConfig } from '@/shared/types.js';

import { createVoiceRouter } from './voice.routes.js';
import { createVoiceService } from './voice.service.js';

const DEFAULT_VOICE_TIMEOUT_MS = 300_000;
const parsedTimeoutMs = Number(process.env.VOICE_TIMEOUT_MS);
const voiceTimeoutMs = Number.isFinite(parsedTimeoutMs) && parsedTimeoutMs > 0
  ? parsedTimeoutMs
  : DEFAULT_VOICE_TIMEOUT_MS;

type EnvironmentPreset = {
  id?: unknown;
  label?: unknown;
  baseUrl?: unknown;
  model?: unknown;
  apiKeyEnv?: unknown;
};

function isAllowedPresetBaseUrl(baseUrl: string): boolean {
  try {
    const parsedUrl = new URL(baseUrl);
    return (parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:')
      && parsedUrl.hostname !== '169.254.169.254'
      && !parsedUrl.hostname.startsWith('169.254.');
  } catch {
    return false;
  }
}

function readTranscriptionPresets(): VoiceTranscriptionPresetConfig[] {
  const rawPresets = process.env.VOICE_STT_PRESETS?.trim();
  if (!rawPresets) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawPresets);
  } catch (error) {
    console.warn('[Voice] Ignoring invalid VOICE_STT_PRESETS JSON:', error);
    return [];
  }

  if (!Array.isArray(parsed)) {
    console.warn('[Voice] VOICE_STT_PRESETS must be a JSON array.');
    return [];
  }

  const presets: VoiceTranscriptionPresetConfig[] = [];
  const seenIds = new Set(['default']);
  for (const value of parsed as EnvironmentPreset[]) {
    const id = typeof value?.id === 'string' ? value.id.trim() : '';
    const label = typeof value?.label === 'string' ? value.label.trim() : '';
    const baseUrl = typeof value?.baseUrl === 'string'
      ? value.baseUrl.trim().replace(/\/$/, '')
      : '';
    const sttModel = typeof value?.model === 'string' ? value.model.trim() : '';
    const apiKeyEnvironmentName = typeof value?.apiKeyEnv === 'string'
      ? value.apiKeyEnv.trim()
      : '';

    if (
      !/^[a-z0-9][a-z0-9_-]*$/i.test(id)
      || !label
      || !isAllowedPresetBaseUrl(baseUrl)
      || !sttModel
      || seenIds.has(id)
    ) {
      console.warn('[Voice] Ignoring incomplete, duplicate, or invalid STT preset:', id || '<unnamed>');
      continue;
    }

    seenIds.add(id);
    presets.push({
      id,
      label,
      baseUrl,
      sttModel,
      apiKey: apiKeyEnvironmentName ? process.env[apiKeyEnvironmentName] || '' : '',
    });
  }

  return presets;
}

const voiceService = createVoiceService({
  defaults: {
    // The server-controlled URL is intentional: the browser selects only an
    // opaque preset id and can never supply an outbound backend destination.
    presetLabel: process.env.VOICE_DEFAULT_PRESET_LABEL || 'Default',
    baseUrl: (process.env.VOICE_API_BASE_URL || '').replace(/\/$/, ''),
    apiKey: process.env.VOICE_API_KEY || '',
    sttModel: process.env.VOICE_STT_MODEL || 'whisper-1',
    ttsModel: process.env.VOICE_TTS_MODEL || 'tts-1',
    ttsVoice: process.env.VOICE_TTS_VOICE || 'alloy',
  },
  transcriptionPresets: readTranscriptionPresets(),
  loadUserOverrides: (userId) => voiceSettingsDb.getVoiceSettings(userId),
  timeoutMs: voiceTimeoutMs,
  fetchBackend: async (url, options) => {
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => abortController.abort(), voiceTimeoutMs);
    try {
      return await fetch(url, {
        redirect: 'manual',
        ...options,
        signal: abortController.signal,
      });
    } finally {
      clearTimeout(timeoutHandle);
    }
  },
});

const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

/** Voice router assembled for the server entrypoint. */
export const voiceRoutes = createVoiceRouter({
  voiceService,
  parseAudioUpload: audioUpload.single('audio'),
});
