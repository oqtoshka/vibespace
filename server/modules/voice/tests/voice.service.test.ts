import assert from 'node:assert/strict';
import test from 'node:test';

import { createVoiceService, MAX_TRANSCRIPTION_PROMPT_LENGTH } from '../voice.service.js';

const defaults = {
  presetLabel: 'OpenAI',
  baseUrl: 'https://voice.example/v1',
  apiKey: 'server-key',
  sttModel: 'whisper-1',
  ttsModel: 'tts-1',
  ttsVoice: 'alloy',
};

test('preserves the entire native audio upload and long multilingual transcript ending', async () => {
  const bytes = Buffer.alloc(8 * 1024 * 1024, 0x5a);
  Buffer.from('end-of-recording').copy(bytes, bytes.length - 16);
  const text = 'English and русский текст. '.repeat(5_000) + 'Последняя фраза — complete ending 🐜';
  const service = createVoiceService({
    defaults,
    transcriptionPresets: [],
    loadUserOverrides: () => ({}),
    timeoutMs: 1_000,
    fetchBackend: async (_url, options) => {
      const form = options.body as FormData;
      const file = form.get('file') as File;
      assert.equal(file.name, 'recording.m4a');
      assert.equal(file.type, 'audio/mp4');
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes);
      assert.equal(form.get('model'), defaults.sttModel);
      return new Response(JSON.stringify({ text }));
    },
  });
  assert.deepEqual(await service.transcribe({
    userId: 42,
    audio: { bytes, mimeType: 'audio/mp4', fileName: 'recording.m4a' },
  }), { ok: true, value: { text } });
});

test('reports whether the server-controlled backend is configured', () => {
  const service = createVoiceService({
    defaults: { ...defaults, baseUrl: '' },
    transcriptionPresets: [],
    loadUserOverrides: () => ({}),
    timeoutMs: 1_000,
    fetchBackend: async () => {
      throw new Error('fetch should not run');
    },
  });

  assert.deepEqual(service.getHealth(), {
    configured: false,
    defaultPresetId: null,
    presets: [],
  });
});

test('reports default and additional transcription presets without exposing backend details', () => {
  const service = createVoiceService({
    defaults,
    transcriptionPresets: [{
      id: 'local-whisper',
      label: 'Local Whisper',
      baseUrl: 'http://ai.internal:8002/v1',
      apiKey: 'local-secret',
      sttModel: 'Systran/faster-whisper-large-v3',
    }],
    loadUserOverrides: () => ({}),
    timeoutMs: 1_000,
    fetchBackend: async () => new Response(),
  });

  assert.deepEqual(service.getHealth(), {
    configured: true,
    defaultPresetId: 'default',
    presets: [
      { id: 'default', label: 'OpenAI', sttModel: 'whisper-1', isDefault: true },
      {
        id: 'local-whisper',
        label: 'Local Whisper',
        sttModel: 'Systran/faster-whisper-large-v3',
        isDefault: false,
      },
    ],
  });
  assert.equal(JSON.stringify(service.getHealth()).includes('local-secret'), false);
  assert.equal(JSON.stringify(service.getHealth()).includes('ai.internal'), false);
});

test('transcribes with injected fetch and user credential/model overrides', async () => {
  let requestedUrl = '';
  let requestedOptions: RequestInit | undefined;
  const service = createVoiceService({
    defaults,
    transcriptionPresets: [],
    loadUserOverrides: () => ({ apiKey: 'request-key', sttModel: 'custom-whisper' }),
    timeoutMs: 1_000,
    fetchBackend: async (url, options) => {
      requestedUrl = url;
      requestedOptions = options;
      return new Response(JSON.stringify({ text: 'hello' }), { status: 200 });
    },
  });

  const result = await service.transcribe({
    userId: 42,
    audio: {
      bytes: Buffer.from('audio'),
      mimeType: 'audio/webm',
      fileName: 'recording.webm',
    },
  });

  assert.deepEqual(result, { ok: true, value: { text: 'hello' } });
  assert.equal(requestedUrl, 'https://voice.example/v1/audio/transcriptions');
  assert.equal((requestedOptions?.headers as Record<string, string>).Authorization, 'Bearer request-key');
  assert.equal((requestedOptions?.body as FormData).get('model'), 'custom-whisper');
});

test('forwards a vocabulary prompt only when one is given, bounded by the owner cap', async () => {
  const bodies: FormData[] = [];
  const service = createVoiceService({
    defaults,
    transcriptionPresets: [],
    loadUserOverrides: () => ({}),
    timeoutMs: 1_000,
    fetchBackend: async (_url, options) => {
      bodies.push(options?.body as FormData);
      return new Response(JSON.stringify({ text: 'ok' }), { status: 200 });
    },
  });
  const audio = { bytes: Buffer.from('audio'), mimeType: 'audio/mp4', fileName: 'recording.m4a' };

  await service.transcribe({ userId: 1, audio, prompt: 'VibeSpace, Mission Control, Кванта.' });
  await service.transcribe({ userId: 1, audio });
  await service.transcribe({ userId: 1, audio, prompt: '   ' });
  await service.transcribe({ userId: 1, audio, prompt: 'x'.repeat(5_000) });

  assert.equal(bodies[0].get('prompt'), 'VibeSpace, Mission Control, Кванта.');
  assert.equal(bodies[1].get('prompt'), null);
  assert.equal(bodies[2].get('prompt'), null);
  assert.equal((bodies[3].get('prompt') as string).length, MAX_TRANSCRIPTION_PROMPT_LENGTH);
});

test('routes a selected transcription preset to its server-owned backend and model', async () => {
  let requestedUrl = '';
  let requestedOptions: RequestInit | undefined;
  const service = createVoiceService({
    defaults,
    transcriptionPresets: [{
      id: 'local-whisper',
      label: 'Local Whisper',
      baseUrl: 'http://192.168.101.8:8002/v1',
      apiKey: '',
      sttModel: 'Systran/faster-whisper-large-v3',
    }],
    loadUserOverrides: () => ({ apiKey: 'openai-key', sttModel: 'openai-model' }),
    timeoutMs: 1_000,
    fetchBackend: async (url, options) => {
      requestedUrl = url;
      requestedOptions = options;
      return new Response(JSON.stringify({ text: 'локальная расшифровка' }), { status: 200 });
    },
  });

  const result = await service.transcribe({
    userId: 42,
    presetId: 'local-whisper',
    audio: {
      bytes: Buffer.from('audio'),
      mimeType: 'audio/webm',
      fileName: 'recording.webm',
    },
  });

  assert.deepEqual(result, { ok: true, value: { text: 'локальная расшифровка' } });
  assert.equal(requestedUrl, 'http://192.168.101.8:8002/v1/audio/transcriptions');
  assert.equal((requestedOptions?.headers as Record<string, string>).Authorization, undefined);
  assert.equal(
    (requestedOptions?.body as FormData).get('model'),
    'Systran/faster-whisper-large-v3',
  );
});

test('rejects an unknown transcription preset before making an outbound request', async () => {
  let fetchCalls = 0;
  const service = createVoiceService({
    defaults,
    transcriptionPresets: [],
    loadUserOverrides: () => ({}),
    timeoutMs: 1_000,
    fetchBackend: async () => {
      fetchCalls += 1;
      return new Response();
    },
  });

  const result = await service.transcribe({
    userId: 42,
    presetId: 'not-configured',
    audio: {
      bytes: Buffer.from('audio'),
      mimeType: 'audio/webm',
      fileName: 'recording.webm',
    },
  });

  assert.deepEqual(result, {
    ok: false,
    status: 400,
    error: 'Unknown voice transcription preset.',
  });
  assert.equal(fetchCalls, 0);
});

test('forwards the user TTS format and maps backend authentication failures', async () => {
  let requestBody = '';
  const service = createVoiceService({
    defaults,
    transcriptionPresets: [],
    loadUserOverrides: () => ({ ttsFormat: 'wav' }),
    timeoutMs: 1_000,
    fetchBackend: async (_url, options) => {
      requestBody = String(options.body);
      return new Response('unauthorized', { status: 401 });
    },
  });

  const result = await service.synthesizeSpeech({
    userId: 42,
    text: 'Read this',
  });

  assert.deepEqual(JSON.parse(requestBody), {
    model: 'tts-1',
    voice: 'alloy',
    input: 'Read this',
    response_format: 'wav',
  });
  assert.deepEqual(result, {
    ok: false,
    status: 502,
    error: 'Voice backend rejected the request (check the API key).',
  });
});

test('blocks link-local metadata destinations before calling the fetch adapter', async () => {
  let fetchCalls = 0;
  const service = createVoiceService({
    defaults: { ...defaults, baseUrl: 'http://169.254.169.254/latest' },
    transcriptionPresets: [],
    loadUserOverrides: () => ({}),
    timeoutMs: 1_000,
    fetchBackend: async () => {
      fetchCalls += 1;
      return new Response();
    },
  });

  const result = await service.synthesizeSpeech({ userId: 42, text: 'hello' });

  assert.deepEqual(result, { ok: false, status: 400, error: 'Invalid voice backend URL.' });
  assert.equal(fetchCalls, 0);
});
