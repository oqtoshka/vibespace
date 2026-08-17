import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  clearOpenCodeModelLimitCache,
  describeOpenCodeCompaction,
  getOpenCodeConfigPath,
  parseOpenCodeModelLimits,
  readOpenCodeDefaultModel,
  readContextOccupancy,
  readOpenCodeCompactionConfig,
  resolveCompactionThreshold,
  resolveOpenCodeModelLimit,
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
    'homelab/local',
    '{',
    '  "id": "local",',
    '  "providerID": "homelab",',
    '  "limit": {',
    '    "context": 65536,',
    '    "output": 8192',
    '  }',
    '}',
    'other/broken',
    '{ not json',
  ].join('\n');

  const limits = parseOpenCodeModelLimits(stdout);
  assert.deepEqual(limits.get('homelab/local'), { context: 65_536, input: null, output: 8_192, source: 'catalog' });
  assert.equal(limits.has('other/broken'), false);
});

test('a missing config reads as OpenCode\'s own defaults', async () => {
  await withConfig(null, async () => {
    assert.deepEqual(readOpenCodeCompactionConfig(), defaults);
  });
});

test('settings round-trip without disturbing the rest of the file', async () => {
  await withConfig({ model: 'homelab/local', share: 'disabled' }, async (configPath) => {
    const saved = await writeOpenCodeCompactionConfig({ auto: false, reserved: 12_000 });
    assert.equal(saved.auto, false);
    assert.equal(saved.reserved, 12_000);

    const written = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(written.model, 'homelab/local');
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
      homelab: {
        npm: '@ai-sdk/openai-compatible',
        models: { local: { name: 'Local (4090)', limit: { context: 65_536, output: 8_192 } } },
      },
    },
  };

  await withConfig(config, async (configPath) => {
    const limit = await writeOpenCodeModelInputLimit('homelab/local', 60_000);
    assert.deepEqual(limit, { context: 65_536, input: 60_000, output: 8_192, source: 'config' });

    const written = JSON.parse(await readFile(configPath, 'utf8'));
    // The rest of the model entry has to survive: its name is what the model
    // picker shows, and npm is what makes the provider work at all.
    assert.equal(written.provider.homelab.npm, '@ai-sdk/openai-compatible');
    assert.equal(written.provider.homelab.models.local.name, 'Local (4090)');
    assert.deepEqual(written.provider.homelab.models.local.limit, {
      context: 65_536,
      output: 8_192,
      input: 60_000,
    });
  });
});

test('the settings screen describes the default model when no session names one', async () => {
  const config = {
    model: 'homelab/local',
    provider: {
      homelab: { models: { local: { limit: { context: 65_536, output: 8_192 } } } },
    },
  };

  await withConfig(config, async () => {
    // Answered from the config alone — no `opencode models` spawn, which is
    // what keeps opening the settings dialog cheap.
    assert.equal(readOpenCodeDefaultModel(), 'homelab/local');

    const described = await describeOpenCodeCompaction(null);
    assert.equal(described.model, 'homelab/local');
    assert.deepEqual(described.limit, { context: 65_536, input: null, output: 8_192, source: 'config' });
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

/**
 * A throwaway vLLM. The point of these tests is that the *server* decides the
 * window and the config follows, so the window here is deliberately not the one
 * in the config.
 */
async function withFakeEngine(
  maxModelLen: number,
  run: (baseURL: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      object: 'list',
      data: [{ id: 'local', object: 'model', owned_by: 'vllm', max_model_len: maxModelLen }],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  try {
    await run(`http://127.0.0.1:${port}/v1`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const engineConfig = (baseURL: string, context: number, extra: Record<string, unknown> = {}) => ({
  model: 'homelab/local',
  provider: {
    homelab: {
      npm: '@ai-sdk/openai-compatible',
      options: { baseURL },
      models: { local: { name: 'Local (4090)', limit: { context, output: 8_192, ...extra } } },
    },
  },
});

test('the serving stack\'s window overrides a stale one, and the config is corrected', async () => {
  await withFakeEngine(139_264, async (baseURL) => {
    await withConfig(engineConfig(baseURL, 65_536), async (configPath) => {
      clearOpenCodeModelLimitCache();

      const limit = await resolveOpenCodeModelLimit('homelab/local');
      assert.equal(limit?.context, 139_264);
      assert.equal(limit?.source, 'provider');

      // Written down, because OpenCode reads this file to decide when to
      // compact. A gauge that knew better than the runtime would be worse than
      // no gauge.
      const written = JSON.parse(await readFile(configPath, 'utf8'));
      assert.equal(written.provider.homelab.models.local.limit.context, 139_264);
      assert.equal(written.provider.homelab.models.local.limit.output, 8_192);
      assert.equal(written.provider.homelab.models.local.name, 'Local (4090)');

      // And the threshold moves with it, which is the whole point.
      assert.equal(
        resolveCompactionThreshold(limit!, defaults),
        139_264 - 8_192,
      );
    });
  });
});

test('a window that shrank is followed down as well as up', async () => {
  // The deployment losing VRAM is the dangerous direction: a request sized
  // against the old window is refused outright, not silently truncated.
  await withFakeEngine(32_768, async (baseURL) => {
    await withConfig(engineConfig(baseURL, 139_264), async (configPath) => {
      clearOpenCodeModelLimitCache();

      assert.equal((await resolveOpenCodeModelLimit('homelab/local'))?.context, 32_768);
      const written = JSON.parse(await readFile(configPath, 'utf8'));
      assert.equal(written.provider.homelab.models.local.limit.context, 32_768);
    });
  });
});

test('an input ceiling written as "the window" moves with the window', async () => {
  // writeOpenCodeModelInputLimit only ever writes the window into limit.input;
  // left behind, it would pin the compaction threshold to the old window.
  await withFakeEngine(139_264, async (baseURL) => {
    await withConfig(engineConfig(baseURL, 65_536, { input: 65_536 }), async (configPath) => {
      clearOpenCodeModelLimitCache();
      await resolveOpenCodeModelLimit('homelab/local');

      const written = JSON.parse(await readFile(configPath, 'utf8'));
      assert.equal(written.provider.homelab.models.local.limit.input, 139_264);
    });
  });
});

test('an input ceiling the user chose is left alone', async () => {
  await withFakeEngine(139_264, async (baseURL) => {
    await withConfig(engineConfig(baseURL, 65_536, { input: 50_000 }), async (configPath) => {
      clearOpenCodeModelLimitCache();
      await resolveOpenCodeModelLimit('homelab/local');

      const written = JSON.parse(await readFile(configPath, 'utf8'));
      assert.equal(written.provider.homelab.models.local.limit.context, 139_264);
      assert.equal(written.provider.homelab.models.local.limit.input, 50_000);
    });
  });
});

test('a config value stands when the server will not answer', async () => {
  await withConfig(engineConfig('http://127.0.0.1:1/v1', 65_536), async (configPath) => {
    clearOpenCodeModelLimitCache();

    const limit = await resolveOpenCodeModelLimit('homelab/local');
    assert.equal(limit?.context, 65_536);
    assert.equal(limit?.source, 'config');

    const written = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(written.provider.homelab.models.local.limit.context, 65_536);
  });
});

test('tracking can be turned off for a deliberately smaller window', async () => {
  await withFakeEngine(139_264, async (baseURL) => {
    await withConfig(engineConfig(baseURL, 65_536), async (configPath) => {
      clearOpenCodeModelLimitCache();
      process.env.VIBESPACE_OPENCODE_TRACK_MODEL_WINDOW = '0';
      try {
        const limit = await resolveOpenCodeModelLimit('homelab/local');
        assert.equal(limit?.context, 65_536);
        assert.equal(limit?.source, 'config');

        const written = JSON.parse(await readFile(configPath, 'utf8'));
        assert.equal(written.provider.homelab.models.local.limit.context, 65_536);
      } finally {
        delete process.env.VIBESPACE_OPENCODE_TRACK_MODEL_WINDOW;
      }
    });
  });
});

test('the server is asked once, not once per turn', async () => {
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests += 1;
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      data: [{ id: 'local', max_model_len: 139_264 }],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };

  try {
    await withConfig(engineConfig(`http://127.0.0.1:${port}/v1`, 65_536), async () => {
      clearOpenCodeModelLimitCache();
      for (let turn = 0; turn < 5; turn += 1) {
        assert.equal((await resolveOpenCodeModelLimit('homelab/local'))?.context, 139_264);
      }
      assert.equal(requests, 1);
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
