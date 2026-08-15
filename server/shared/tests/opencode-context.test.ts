import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  describeOpenCodeCompaction,
  getOpenCodeConfigPath,
  parseOpenCodeModelLimits,
  readOpenCodeDefaultModel,
  readContextOccupancy,
  readOpenCodeCompactionConfig,
  resolveCompactionThreshold,
  writeOpenCodeCompactionConfig,
  writeOpenCodeModelInputLimit,
  type OpenCodeCompactionConfig,
} from '@/shared/opencode-context.js';

/**
 * Points XDG_CONFIG_HOME at a scratch directory so the tests read and write a
 * throwaway `opencode.json` instead of the developer's own.
 */
async function withConfig(
  contents: unknown | null,
  run: (configPath: string) => Promise<void>,
): Promise<void> {
  const previous = process.env.XDG_CONFIG_HOME;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'opencode-context-'));
  process.env.XDG_CONFIG_HOME = directory;

  try {
    const configPath = getOpenCodeConfigPath();
    if (contents !== null) {
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(configPath, JSON.stringify(contents, null, 2), 'utf8');
    }
    await run(configPath);
  } finally {
    if (previous === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = previous;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

const defaults: OpenCodeCompactionConfig = {
  auto: true,
  prune: false,
  tailTurns: null,
  preserveRecentTokens: null,
  reserved: null,
};

test('a window with no declared input ceiling compacts at context minus output', () => {
  // This is the case that made the panel look wrong: a 64k model whose session
  // row had counted 200k of cumulative spend.
  const threshold = resolveCompactionThreshold({ context: 65_536, input: null, output: 8_192 }, defaults);
  assert.equal(threshold, 57_344);
});

test('`reserved` is ignored without an input ceiling, and honored with one', () => {
  const limit = { context: 65_536, input: null, output: 8_192 };
  const withReserved = { ...defaults, reserved: 20_000 };

  // OpenCode reads `reserved` and then does not apply it — the branch it feeds
  // is only taken when the model declares limit.input.
  assert.equal(resolveCompactionThreshold(limit, withReserved), 57_344);
  assert.equal(
    resolveCompactionThreshold({ ...limit, input: 65_536 }, withReserved),
    45_536,
  );
});

test('an unknown window yields no threshold rather than a made-up one', () => {
  assert.equal(resolveCompactionThreshold({ context: 0, input: null, output: 8_192 }, defaults), 0);
});

test('occupancy is one turn, not the session total', () => {
  // Cache reads are part of what occupies the window, so they count.
  assert.equal(
    readContextOccupancy({ input: 30_000, output: 500, cache: { read: 12_000, write: 200 } }),
    42_700,
  );
  // A reported total wins: it is the runtime's own number.
  assert.equal(readContextOccupancy({ total: 41_000, input: 30_000, output: 500 }), 41_000);
  assert.equal(readContextOccupancy(null), 0);
});

test('the model catalog is read for its limits', () => {
  const stdout = [
    'dudin/local',
    '{',
    '  "id": "local",',
    '  "providerID": "dudin",',
    '  "limit": {',
    '    "context": 65536,',
    '    "output": 8192',
    '  }',
    '}',
    'other/broken',
    '{ not json',
  ].join('\n');

  const limits = parseOpenCodeModelLimits(stdout);
  assert.deepEqual(limits.get('dudin/local'), { context: 65_536, input: null, output: 8_192 });
  assert.equal(limits.has('other/broken'), false);
});

test('a missing config reads as OpenCode\'s own defaults', async () => {
  await withConfig(null, async () => {
    assert.deepEqual(readOpenCodeCompactionConfig(), defaults);
  });
});

test('settings round-trip without disturbing the rest of the file', async () => {
  await withConfig({ model: 'dudin/local', share: 'disabled' }, async (configPath) => {
    const saved = await writeOpenCodeCompactionConfig({ auto: false, reserved: 12_000 });
    assert.equal(saved.auto, false);
    assert.equal(saved.reserved, 12_000);

    const written = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(written.model, 'dudin/local');
    assert.equal(written.share, 'disabled');
    assert.deepEqual(written.compaction, { auto: false, reserved: 12_000 });
  });
});

test('null clears a field instead of freezing today\'s default into the file', async () => {
  await withConfig({ compaction: { auto: false, reserved: 12_000, tail_turns: 15 } }, async (configPath) => {
    await writeOpenCodeCompactionConfig({ reserved: null });

    const written = JSON.parse(await readFile(configPath, 'utf8'));
    assert.deepEqual(written.compaction, { auto: false, tail_turns: 15 });
  });
});

test('an input ceiling can be declared for a model the config owns', async () => {
  const config = {
    provider: {
      dudin: {
        npm: '@ai-sdk/openai-compatible',
        models: { local: { name: 'Local (4090)', limit: { context: 65_536, output: 8_192 } } },
      },
    },
  };

  await withConfig(config, async (configPath) => {
    const limit = await writeOpenCodeModelInputLimit('dudin/local', 60_000);
    assert.deepEqual(limit, { context: 65_536, input: 60_000, output: 8_192 });

    const written = JSON.parse(await readFile(configPath, 'utf8'));
    // The rest of the model entry has to survive: its name is what the model
    // picker shows, and npm is what makes the provider work at all.
    assert.equal(written.provider.dudin.npm, '@ai-sdk/openai-compatible');
    assert.equal(written.provider.dudin.models.local.name, 'Local (4090)');
    assert.deepEqual(written.provider.dudin.models.local.limit, {
      context: 65_536,
      output: 8_192,
      input: 60_000,
    });
  });
});

test('the settings screen describes the default model when no session names one', async () => {
  const config = {
    model: 'dudin/local',
    provider: {
      dudin: { models: { local: { limit: { context: 65_536, output: 8_192 } } } },
    },
  };

  await withConfig(config, async () => {
    // Answered from the config alone — no `opencode models` spawn, which is
    // what keeps opening the settings dialog cheap.
    assert.equal(readOpenCodeDefaultModel(), 'dudin/local');

    const described = await describeOpenCodeCompaction(null);
    assert.equal(described.model, 'dudin/local');
    assert.deepEqual(described.limit, { context: 65_536, input: null, output: 8_192 });
    assert.equal(described.compactAtTokens, 57_344);
    assert.equal(described.reservedHonored, false);
  });
});

test('a bare model name is not mistaken for a provider/model id', async () => {
  await withConfig({ model: 'local' }, async () => {
    assert.equal(readOpenCodeDefaultModel(), null);
  });
});

test('a model the config does not declare is refused rather than invented', async () => {
  await withConfig({ model: 'anthropic/claude-sonnet-4-5' }, async () => {
    assert.equal(await writeOpenCodeModelInputLimit('anthropic/claude-sonnet-4-5', 100_000), null);
  });
});
