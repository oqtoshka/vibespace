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

function box(type: string, ...payload: Buffer[]): Buffer {
  const body = Buffer.concat(payload);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + body.length, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, body]);
}

/** A minimal M4A laid out like a phone recording: ftyp, the audio, then moov/mvhd with its length. */
function m4aRecording(seconds: number, version: 0 | 1 = 0): Buffer {
  const timescale = 44_100;
  const duration = Math.round(seconds * timescale);
  const mvhd = Buffer.alloc(version === 1 ? 112 : 100);
  mvhd[0] = version;
  if (version === 1) {
    mvhd.writeUInt32BE(timescale, 20);
    mvhd.writeBigUInt64BE(BigInt(duration), 24);
  } else {
    mvhd.writeUInt32BE(timescale, 12);
    mvhd.writeUInt32BE(duration, 16);
  }
  return Buffer.concat([
    box('ftyp', Buffer.from('M4A \0\0\0\0M4A mp42isom', 'latin1')),
    box('mdat', Buffer.alloc(4_096, 0x21)),
    box('moov', box('mvhd', mvhd)),
  ]);
}

test('sends every model the plain request and returns its transcript as is', async () => {
  const bodies: FormData[] = [];
  let sttModel = '';
  const service = createVoiceService({
    defaults,
    transcriptionPresets: [{
      id: 'local-whisper',
      label: 'Local Whisper',
      baseUrl: 'http://ai.internal:8002/v1',
      apiKey: '',
      sttModel: 'Systran/faster-whisper-large-v3',
    }],
    loadUserOverrides: () => ({ sttModel }),
    timeoutMs: 1_000,
    fetchBackend: async (_url, options) => {
      bodies.push(options.body as FormData);
      return new Response(JSON.stringify({ text: 'first line\nsecond line ' }));
    },
  });
  const audio = { bytes: Buffer.from('audio'), mimeType: 'audio/mp4', fileName: 'recording.m4a' };

  const results = [];
  // Server-side chunking (chunking_strategy) dropped more of a long dictation
  // than one block, so no model gets it.
  for (const model of ['gpt-transcribe', 'gpt-4o-transcribe', '']) {
    sttModel = model;
    results.push(await service.transcribe({ userId: 1, audio }));
  }
  results.push(await service.transcribe({ userId: 1, audio, presetId: 'local-whisper' }));

  for (const result of results) {
    assert.deepEqual(result, { ok: true, value: { text: 'first line\nsecond line ' } });
  }
  assert.deepEqual(bodies.map((body) => [...body.keys()]), Array(4).fill(['file', 'model']));
  assert.deepEqual(bodies.map((body) => body.get('model')), [
    'gpt-transcribe',
    'gpt-4o-transcribe',
    'whisper-1',
    'Systran/faster-whisper-large-v3',
  ]);
});

test('reports every transcription with its sizes and usage, never its text or prompt', async () => {
  const reports: Record<string, unknown>[] = [];
  const responses = [
    // gpt-transcribe bills by duration...
    new Response(JSON.stringify({
      text: 'секретный текст диктовки',
      languages: ['ru'],
      usage: { type: 'duration', seconds: 62 },
    })),
    // ...gpt-4o-transcribe by tokens.
    new Response(JSON.stringify({
      text: 'секретный текст',
      usage: {
        type: 'tokens',
        input_tokens: 620,
        input_token_details: { text_tokens: 5, audio_tokens: 615 },
        output_tokens: 9,
        total_tokens: 629,
      },
    })),
    new Response('server exploded', { status: 500 }),
  ];
  let sttModel = 'gpt-transcribe';
  const service = createVoiceService({
    defaults,
    transcriptionPresets: [],
    loadUserOverrides: () => ({ sttModel }),
    timeoutMs: 1_000,
    fetchBackend: async () => {
      const response = responses.shift();
      if (!response) throw new Error('connect ECONNREFUSED');
      return response;
    },
    reportTranscription: (report) => reports.push({ ...report, elapsedMs: typeof report.elapsedMs }),
  });
  const audio = { bytes: m4aRecording(61.5), mimeType: 'audio/mp4', fileName: 'recording.m4a' };
  const prompt = 'Кванта, Mission Control';

  await service.transcribe({ userId: 42, audio, prompt });
  sttModel = 'gpt-4o-transcribe';
  await service.transcribe({ userId: 42, audio, prompt });
  await service.transcribe({ userId: 42, audio, prompt });
  await service.transcribe({ userId: 42, audio, prompt });

  const request = (model: string) => ({
    model,
    promptCharacters: prompt.length,
    audioBytes: audio.bytes.length,
    audioSeconds: 61.5,
    elapsedMs: 'number',
  });
  assert.deepEqual(reports, [
    {
      ...request('gpt-transcribe'),
      status: 200,
      characters: 'секретный текст диктовки'.length,
      words: 3,
      audioTokens: undefined,
      outputTokens: undefined,
      billedSeconds: 62,
    },
    {
      ...request('gpt-4o-transcribe'),
      status: 200,
      characters: 'секретный текст'.length,
      words: 2,
      audioTokens: 615,
      outputTokens: 9,
      billedSeconds: undefined,
    },
    { ...request('gpt-4o-transcribe'), status: 500 },
    { ...request('gpt-4o-transcribe'), status: 0 },
  ]);
  assert.equal(JSON.stringify(reports).includes('секретный'), false);
  assert.equal(JSON.stringify(reports).includes('Кванта'), false);
});

test('reads the recording length from either MP4 header version and tolerates other formats', async () => {
  const lengths: (number | undefined)[] = [];
  const service = createVoiceService({
    defaults,
    transcriptionPresets: [],
    loadUserOverrides: () => ({}),
    timeoutMs: 1_000,
    fetchBackend: async () => new Response(JSON.stringify({ text: 'ok', usage: { type: 'duration', seconds: 3 } })),
    reportTranscription: (report) => lengths.push(report.audioSeconds),
  });
  const transcribe = (bytes: Buffer, mimeType = 'audio/mp4') => service.transcribe({
    userId: 1,
    audio: { bytes, mimeType, fileName: 'recording' },
  });

  await transcribe(m4aRecording(3));
  await transcribe(m4aRecording(5_000.04, 1));
  await transcribe(Buffer.from('webm audio, no MP4 boxes'), 'audio/webm');
  await transcribe(m4aRecording(3).subarray(0, 60));
  await transcribe(Buffer.alloc(0));

  assert.deepEqual(lengths, [3, 5_000, undefined, undefined, undefined]);
});

test('a failing transcription reporter never fails the transcription', async () => {
  const service = createVoiceService({
    defaults,
    transcriptionPresets: [],
    loadUserOverrides: () => ({}),
    timeoutMs: 1_000,
    fetchBackend: async () => new Response(JSON.stringify({ text: 'still delivered' })),
    reportTranscription: () => {
      throw new Error('log sink is gone');
    },
  });

  assert.deepEqual(await service.transcribe({
    userId: 1,
    audio: { bytes: Buffer.from('audio'), mimeType: 'audio/mp4', fileName: 'recording.m4a' },
  }), { ok: true, value: { text: 'still delivered' } });
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
