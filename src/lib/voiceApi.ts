import { authenticatedFetch } from '../utils/api';

// STT/TTS always go through the server's /api/voice proxy: the backend base URL
// and the user's stored API key live server-side (see useVoiceConfig), so the
// browser never handles the key or talks to the audio backend directly.

export function transcribeVoice(blob: Blob, filename: string, signal?: AbortSignal): Promise<Response> {
  const body = new FormData();
  body.append('audio', blob, filename);
  return authenticatedFetch('/api/voice/transcribe', {
    method: 'POST',
    body,
    signal,
  });
}

export function synthesizeVoice(text: string, signal: AbortSignal): Promise<Response> {
  return authenticatedFetch('/api/voice/tts', {
    method: 'POST',
    body: JSON.stringify({ text }),
    signal,
  });
}
