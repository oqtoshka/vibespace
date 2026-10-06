import assert from 'node:assert/strict';
import test from 'node:test';

import { CursorProviderModels, CURSOR_PREDEFINED_MODELS } from '../list/cursor/cursor-models.provider.js';

test('Cursor catalog preserves auto and unique selectable IDs', async () => {
  const models = await new CursorProviderModels().getSupportedModels();
  assert.equal(models.DEFAULT, 'auto');
  assert.ok(models.OPTIONS.some(option => option.value === models.DEFAULT));
  assert.equal(new Set(models.OPTIONS.map(option => option.value)).size, models.OPTIONS.length);
});

test('Cursor reasoning variants carry the exact ID passed to the CLI, without separate effort', () => {
  assert.ok(CURSOR_PREDEFINED_MODELS.OPTIONS.some(option => option.value === 'gpt-5.6-sol-high'));
  assert.ok(CURSOR_PREDEFINED_MODELS.OPTIONS.some(option => option.value === 'claude-opus-5-thinking-max'));
  assert.ok(!CURSOR_PREDEFINED_MODELS.OPTIONS.some(option => option.value === 'gpt-5.6-sol'));
  assert.ok(CURSOR_PREDEFINED_MODELS.OPTIONS.every(option => !('effort' in option)));
});

test('Cursor with no recorded session keeps the automatic default', async () => {
  assert.deepEqual(await new CursorProviderModels().getCurrentActiveModel(), { model: 'auto' });
});
