import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import type { VoiceService } from '@/shared/types.js';

import { createVoiceRouter } from '../voice.routes.js';

test('passes the authenticated user and selected preset to transcription service', async () => {
  const captured: { transcriptionInput?: Parameters<VoiceService['transcribe']>[0] } = {};
  const voiceService: VoiceService = {
    getHealth: () => ({ configured: true, defaultPresetId: 'default', presets: [] }),
    transcribe: async (input) => {
      captured.transcriptionInput = input;
      return { ok: true, value: { text: 'hello' } };
    },
    synthesizeSpeech: async () => ({
      ok: true,
      value: { contentType: 'audio/mpeg', body: null },
    }),
  };

  const app = express();
  app.use((request, _response, next) => {
    (request as express.Request & { user?: { id: number } }).user = { id: 42 };
    next();
  });
  app.use(createVoiceRouter({
    voiceService,
    parseAudioUpload: (request, _response, next) => {
      request.file = {
        buffer: Buffer.from('audio'),
        mimetype: 'audio/webm',
        originalname: 'recording.webm',
      } as Express.Multer.File;
      next();
    },
  }));

  const server = app.listen(0);
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/transcribe`, {
      method: 'POST',
      headers: { 'x-voice-preset': 'local-whisper' },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { text: 'hello' });
    assert.equal(captured.transcriptionInput?.userId, 42);
    assert.equal(captured.transcriptionInput?.presetId, 'local-whisper');
    assert.equal(captured.transcriptionInput?.audio.fileName, 'recording.webm');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
