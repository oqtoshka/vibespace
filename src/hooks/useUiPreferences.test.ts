import assert from 'node:assert/strict';
import test from 'node:test';

import { readInitialPreferences, readVoiceEnabledPreference } from './useUiPreferences';

type StoredValues = Record<string, string>;

function withLocalStorage(values: StoredValues, run: () => void) {
  const originalWindow = globalThis.window;
  const originalLocalStorage = globalThis.localStorage;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (key: string) => values[key] ?? null },
  });
  try {
    run();
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: originalLocalStorage,
    });
  }
}

test('enables voice for a fresh browser', () => {
  withLocalStorage({}, () => {
    assert.equal(readInitialPreferences('uiPreferences.v3').voiceEnabled, true);
    assert.equal(readVoiceEnabledPreference(), true);
  });
});

test('migrates the old v2 default to enabled while preserving other choices', () => {
  withLocalStorage({
    'uiPreferences.v2': JSON.stringify({
      showRawParameters: true,
      showThinking: false,
      sendByCtrlEnter: false,
      sidebarVisible: false,
      voiceEnabled: false,
    }),
  }, () => {
    const preferences = readInitialPreferences('uiPreferences.v3');
    assert.equal(preferences.voiceEnabled, true);
    assert.equal(preferences.sendByCtrlEnter, false);
    assert.equal(preferences.sidebarVisible, false);
    assert.equal(readVoiceEnabledPreference(), true);
  });
});

test('preserves an explicit opt-out after the v3 migration', () => {
  withLocalStorage({
    'uiPreferences.v3': JSON.stringify({ voiceEnabled: false }),
  }, () => {
    assert.equal(readInitialPreferences('uiPreferences.v3').voiceEnabled, false);
    assert.equal(readVoiceEnabledPreference(), false);
  });
});

test('migrates the pre-v2 defaults for send and voice together', () => {
  withLocalStorage({
    uiPreferences: JSON.stringify({ sendByCtrlEnter: false, voiceEnabled: false }),
  }, () => {
    const preferences = readInitialPreferences('uiPreferences.v3');
    assert.equal(preferences.sendByCtrlEnter, true);
    assert.equal(preferences.voiceEnabled, true);
  });
});
