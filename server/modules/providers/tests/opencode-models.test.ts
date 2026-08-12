import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildOpenCodeDefinitionFromVerboseModels,
  buildOpenCodeDefinitionFromIds,
  parseOpenCodeModelsStdout,
  parseOpenCodeVerboseModelsStdout,
  readOpenCodeConfiguredModel,
  stripJsonComments,
} from '@/modules/providers/list/opencode/opencode-models.provider.js';

test('OpenCode models provider parses plain CLI output and removes duplicates', () => {
  const ids = parseOpenCodeModelsStdout(`
opencode/big-pickle
not a model
anthropic/claude-opus-4-7-fast
anthropic/claude-opus-4-7-fast
openai/gpt-5.5-pro
`);

  assert.deepEqual(ids, [
    'opencode/big-pickle',
    'anthropic/claude-opus-4-7-fast',
    'openai/gpt-5.5-pro',
  ]);
});

test('OpenCode models provider keeps ids whose model half contains a slash', () => {
  const ids = parseOpenCodeModelsStdout(`
dudin/cyankiwi/Qwen3.6-27B-AWQ-INT4
opencode/big-pickle
`);

  assert.deepEqual(ids, [
    'dudin/cyankiwi/Qwen3.6-27B-AWQ-INT4',
    'opencode/big-pickle',
  ]);
});

test('OpenCode models provider formats frontend labels from provider-prefixed ids', () => {
  const definition = buildOpenCodeDefinitionFromIds([
    'opencode/deepseek-v4-flash-free',
    'opencode/nemotron-3-super-free',
    'anthropic/claude-3-5-sonnet-20241022',
    'anthropic/claude-opus-4-7-fast',
    'google/model-alpha',
    'openai/gpt-5.4-mini-fast',
    'openai/gpt-5.5-pro',
    'newprovider/alpha-v12-special-20261231',
  ]);

  assert.deepEqual(definition.OPTIONS, [
    {
      value: 'opencode/deepseek-v4-flash-free',
      label: 'Deepseek V4 Flash Free',
      description: 'opencode - opencode/deepseek-v4-flash-free',
    },
    {
      value: 'opencode/nemotron-3-super-free',
      label: 'Nemotron 3 Super Free',
      description: 'opencode - opencode/nemotron-3-super-free',
    },
    {
      value: 'anthropic/claude-3-5-sonnet-20241022',
      label: 'Claude 3.5 Sonnet (2024-10-22)',
      description: 'anthropic - anthropic/claude-3-5-sonnet-20241022',
    },
    {
      value: 'anthropic/claude-opus-4-7-fast',
      label: 'Claude Opus 4.7 Fast',
      description: 'anthropic - anthropic/claude-opus-4-7-fast',
    },
    {
      value: 'openai/gpt-5.4-mini-fast',
      label: 'GPT-5.4 Mini Fast',
      description: 'openai - openai/gpt-5.4-mini-fast',
    },
    {
      value: 'openai/gpt-5.5-pro',
      label: 'GPT-5.5 Pro',
      description: 'openai - openai/gpt-5.5-pro',
    },
    {
      value: 'newprovider/alpha-v12-special-20261231',
      label: 'Alpha V12 Special (2026-12-31)',
      description: 'newprovider - newprovider/alpha-v12-special-20261231',
    },
  ]);
});

test('OpenCode models provider maps verbose model variants to effort options', () => {
  const models = parseOpenCodeVerboseModelsStdout(`
opencode/deepseek-v4-flash-free
{
  "id": "deepseek-v4-flash-free",
  "providerID": "opencode",
  "name": "DeepSeek V4 Flash Free",
  "variants": {
    "low": {
      "reasoningEffort": "low"
    },
    "high": {
      "reasoningEffort": "high"
    }
  }
}
anthropic/claude-sonnet-5
{
  "id": "claude-sonnet-5",
  "providerID": "anthropic",
  "name": "Claude Sonnet 5",
  "variants": {
    "low": {
      "effort": "low"
    },
    "max": {
      "effort": "max"
    }
  }
}
google/model-alpha
{
  "id": "model-alpha",
  "providerID": "google",
  "name": "Model Alpha"
}
`);

  const definition = buildOpenCodeDefinitionFromVerboseModels(models);

  assert.deepEqual(definition.OPTIONS, [
    {
      value: 'opencode/deepseek-v4-flash-free',
      label: 'DeepSeek V4 Flash Free',
      description: 'opencode - opencode/deepseek-v4-flash-free',
      effort: {
        values: [
          { value: 'low' },
          { value: 'high' },
        ],
      },
    },
    {
      value: 'anthropic/claude-sonnet-5',
      label: 'Claude Sonnet 5',
      description: 'anthropic - anthropic/claude-sonnet-5',
      effort: {
        values: [
          { value: 'low' },
          { value: 'max' },
        ],
      },
    },
  ]);
});

test('OpenCode models provider qualifies custom-provider models whose id contains a slash', () => {
  const models = parseOpenCodeVerboseModelsStdout(`
dudin/cyankiwi/Qwen3.6-27B-AWQ-INT4
{
  "id": "cyankiwi/Qwen3.6-27B-AWQ-INT4",
  "providerID": "dudin",
  "name": "Qwen 3.6 27B (AWQ INT4)"
}
opencode/big-pickle
{
  "id": "big-pickle",
  "providerID": "opencode",
  "name": "Big Pickle"
}
`);

  const definition = buildOpenCodeDefinitionFromVerboseModels(models);

  assert.deepEqual(definition.OPTIONS.map((option) => option.value), [
    'dudin/cyankiwi/Qwen3.6-27B-AWQ-INT4',
    'opencode/big-pickle',
  ]);
});

test('OpenCode models provider prefers the model configured in opencode.json', () => {
  const models = parseOpenCodeVerboseModelsStdout(`
opencode/big-pickle
{
  "id": "big-pickle",
  "providerID": "opencode",
  "name": "Big Pickle"
}
dudin/cyankiwi/Qwen3.6-27B-AWQ-INT4
{
  "id": "cyankiwi/Qwen3.6-27B-AWQ-INT4",
  "providerID": "dudin",
  "name": "Qwen 3.6 27B (AWQ INT4)"
}
`);

  assert.equal(
    buildOpenCodeDefinitionFromVerboseModels(models, 'dudin/cyankiwi/Qwen3.6-27B-AWQ-INT4').DEFAULT,
    'dudin/cyankiwi/Qwen3.6-27B-AWQ-INT4',
  );
  assert.equal(buildOpenCodeDefinitionFromVerboseModels(models, 'gone/model').DEFAULT, 'opencode/big-pickle');
  assert.equal(buildOpenCodeDefinitionFromVerboseModels(models).DEFAULT, 'opencode/big-pickle');
});

test('OpenCode models provider reads the configured model out of a commented config', async (t) => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-config-'));
  const previousConfigDir = process.env.OPENCODE_CONFIG_DIR;
  const previousConfig = process.env.OPENCODE_CONFIG;

  delete process.env.OPENCODE_CONFIG;
  process.env.OPENCODE_CONFIG_DIR = configDir;

  t.after(() => {
    if (previousConfigDir === undefined) {
      delete process.env.OPENCODE_CONFIG_DIR;
    } else {
      process.env.OPENCODE_CONFIG_DIR = previousConfigDir;
    }
    if (previousConfig !== undefined) {
      process.env.OPENCODE_CONFIG = previousConfig;
    }
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  assert.equal(readOpenCodeConfiguredModel(), null);

  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ model: 'opencode/big-pickle' }));
  assert.equal(readOpenCodeConfiguredModel(), 'opencode/big-pickle');

  // Later candidates override earlier ones, matching OpenCode's own loader.
  fs.writeFileSync(
    path.join(configDir, 'opencode.jsonc'),
    `{
  // self-hosted vLLM
  "model": "dudin/cyankiwi/Qwen3.6-27B-AWQ-INT4" /* not opencode zen */
}`,
  );
  assert.equal(readOpenCodeConfiguredModel(), 'dudin/cyankiwi/Qwen3.6-27B-AWQ-INT4');
});

test('stripJsonComments leaves comment-like sequences inside strings alone', () => {
  assert.equal(
    stripJsonComments('{"baseURL": "https://llm.dudin.net/v1", // trailing\n "a": 1}'),
    '{"baseURL": "https://llm.dudin.net/v1", \n "a": 1}',
  );
});
