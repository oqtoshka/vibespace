import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import {
  toClientVoiceSettings,
  voiceSettingsDb,
} from '@/modules/database/repositories/voice-settings.js';
import { userDb } from '@/modules/database/repositories/users.js';

async function withIsolatedDatabase(runTest: (userId: number) => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'voice-settings-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    const user = userDb.createUser('voice-tester', 'hash');
    await runTest(Number(user.id));
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('voiceSettingsDb returns defaults for a user with no stored settings', async () => {
  await withIsolatedDatabase((userId) => {
    const settings = voiceSettingsDb.getVoiceSettings(userId);
    assert.deepEqual(settings, { apiKey: '', sttModel: '', ttsModel: '', ttsVoice: '', ttsFormat: '' });
  });
});

test('voiceSettingsDb persists settings across reads', async () => {
  await withIsolatedDatabase((userId) => {
    voiceSettingsDb.updateVoiceSettings(userId, {
      apiKey: 'sk-test-1234',
      sttModel: 'gpt-4o-mini-transcribe',
      ttsModel: 'tts-1',
    });

    const settings = voiceSettingsDb.getVoiceSettings(userId);
    assert.equal(settings.apiKey, 'sk-test-1234');
    assert.equal(settings.sttModel, 'gpt-4o-mini-transcribe');
    assert.equal(settings.ttsModel, 'tts-1');
  });
});

test('blank or masked api key keeps the stored secret; clearApiKey wipes it', async () => {
  await withIsolatedDatabase((userId) => {
    voiceSettingsDb.updateVoiceSettings(userId, { apiKey: 'sk-test-1234' });

    voiceSettingsDb.updateVoiceSettings(userId, { apiKey: '', sttModel: 'whisper-1' });
    assert.equal(voiceSettingsDb.getVoiceSettings(userId).apiKey, 'sk-test-1234');

    voiceSettingsDb.updateVoiceSettings(userId, { apiKey: '••••1234' });
    assert.equal(voiceSettingsDb.getVoiceSettings(userId).apiKey, 'sk-test-1234');

    voiceSettingsDb.updateVoiceSettings(userId, { clearApiKey: true });
    assert.equal(voiceSettingsDb.getVoiceSettings(userId).apiKey, '');
  });
});

test('toClientVoiceSettings masks the api key', async () => {
  await withIsolatedDatabase((userId) => {
    const stored = voiceSettingsDb.updateVoiceSettings(userId, { apiKey: 'sk-test-abcd' });
    const client = toClientVoiceSettings(stored);

    assert.equal(client.apiKeySet, true);
    assert.equal(client.apiKeyHint, '••••abcd');
    assert.equal('apiKey' in client, false);
  });
});
