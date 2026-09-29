import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CODEX_PREDEFINED_MODELS,
  CodexProviderModels,
} from '@/modules/providers/list/codex/codex-models.provider.js';

const require = createRequire(import.meta.url);

test('the Codex catalog offers GPT-6 Astra with every supported effort', () => {
  const astra = CODEX_PREDEFINED_MODELS.OPTIONS.find((model) => model.value === 'gpt-6-astra');

  assert.ok(astra);
  assert.equal(astra.label, 'GPT-6 Astra');
  assert.equal(astra.effort?.default, 'medium');
  assert.deepEqual(
    astra.effort?.values.map((effort) => effort.value),
    ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  );
});

test('the Codex catalog offers GPT-6 Sol and Luna with the supported effort levels', () => {
  const sol = CODEX_PREDEFINED_MODELS.OPTIONS.find((model) => model.value === 'gpt-6-sol');
  const luna = CODEX_PREDEFINED_MODELS.OPTIONS.find((model) => model.value === 'gpt-6-luna');

  assert.equal(sol?.label, 'GPT-6 Sol');
  assert.equal(sol?.effort?.default, 'medium');
  assert.deepEqual(
    sol?.effort?.values.map((effort) => effort.value),
    ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  );
  assert.equal(luna?.label, 'GPT-6 Luna');
  assert.equal(luna?.effort?.default, 'medium');
  assert.deepEqual(
    luna?.effort?.values.map((effort) => effort.value),
    ['low', 'medium', 'high', 'xhigh', 'max'],
  );
});

test('the Codex catalog offers GPT-6.1 Sol as the default with every supported effort', () => {
  const sol = CODEX_PREDEFINED_MODELS.OPTIONS.find((model) => model.value === 'gpt-6.1-sol');

  assert.equal(sol?.label, 'GPT-6.1 Sol');
  assert.equal(sol?.effort?.default, 'medium');
  assert.deepEqual(
    sol?.effort?.values.map((effort) => effort.value),
    ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  );
  assert.equal(CODEX_PREDEFINED_MODELS.DEFAULT, 'gpt-6.1-sol');
});

type BundledCodexModel = {
  slug: string;
  visibility?: string;
  supported_reasoning_levels?: Array<{ effort: string }>;
};

/**
 * The model list the bundled CLI actually ships — what `codex app-server`
 * accepts — rather than its package version, which proves nothing about which
 * slugs and efforts it knows. `--bundled` skips the network refresh, and an
 * empty CODEX_HOME keeps the developer's own config and cache out of it.
 */
function readBundledCodexModels(): Map<string, BundledCodexModel> {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'codex-models-test-'));
  try {
    const output = execFileSync(
      process.execPath,
      [require.resolve('@openai/codex/bin/codex.js'), 'debug', 'models', '--bundled'],
      { encoding: 'utf8', env: { ...process.env, CODEX_HOME: codexHome }, timeout: 30_000 },
    );
    const { models } = JSON.parse(output) as { models: BundledCodexModel[] };
    return new Map(models.map((model) => [model.slug, model]));
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
}

const bundledEfforts = (model: BundledCodexModel | undefined) =>
  model?.supported_reasoning_levels?.map((level) => level.effort);

// Older models the bundled catalog no longer lists but the app still offers
// for sessions that were started on them.
const RETIRED_FROM_BUNDLED_CATALOG = new Set(['gpt-5.4', 'gpt-5.4-mini']);

test('the bundled Codex CLI lists GPT-6.1 Sol with the effort set the catalog offers', () => {
  const bundled = readBundledCodexModels().get('gpt-6.1-sol');

  assert.ok(bundled, 'the bundled Codex CLI does not know gpt-6.1-sol');
  assert.equal(bundled.visibility, 'list');
  assert.deepEqual(bundledEfforts(bundled), ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
});

test('every catalog model is one the bundled Codex CLI knows, with the same efforts', () => {
  const bundled = readBundledCodexModels();

  for (const option of CODEX_PREDEFINED_MODELS.OPTIONS) {
    if (RETIRED_FROM_BUNDLED_CATALOG.has(option.value)) {
      continue;
    }
    const model = bundled.get(option.value);
    assert.ok(model, `the bundled Codex CLI does not know ${option.value}`);
    assert.deepEqual(
      option.effort?.values.map((effort) => effort.value),
      bundledEfforts(model),
      `${option.value} efforts differ from the bundled Codex CLI`,
    );
  }
  assert.ok(bundled.has(CODEX_PREDEFINED_MODELS.DEFAULT));
});

test('the Codex catalog fingerprint invalidates persisted catalogs from older releases', async () => {
  const provider = new CodexProviderModels();

  assert.equal(await provider.getCatalogFingerprint(), JSON.stringify(CODEX_PREDEFINED_MODELS));
});
