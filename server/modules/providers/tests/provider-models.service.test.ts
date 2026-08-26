import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createProviderModelsService,
  PROVIDER_MODELS_CACHE_TTL_MS,
  PROVIDER_MODELS_PROVISIONAL_CACHE_TTL_MS,
} from '@/modules/providers/services/provider-models.service.js';
import type {
  CustomProviderModelInput,
  CustomProviderModelRecord,
  ProviderChangeActiveModelInput,
  LLMProvider,
  ProviderCurrentActiveModel,
  ProviderModelsDefinition,
  ProviderSessionActiveModelChange,
} from '@/shared/types.js';
import { AppError, writeProviderSessionActiveModelChange } from '@/shared/utils.js';

const createModels = (value: string): ProviderModelsDefinition => ({
  OPTIONS: [{ value, label: value }],
  DEFAULT: value,
});

const createCurrentActiveModel = (model: string): ProviderCurrentActiveModel => ({
  model,
});

const createSessionActiveModelChange = (
  provider: LLMProvider,
  input: ProviderChangeActiveModelInput,
): ProviderSessionActiveModelChange => ({
  provider,
  sessionId: input.sessionId,
  supported: true,
  changed: true,
  model: input.model,
});

const createEphemeralCachePath = (): string => path.join(
  os.tmpdir(),
  `provider-model-cache-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
);

test('provider models service delegates to the resolved provider model adapter', async () => {
  const calls: LLMProvider[] = [];
  const service = createProviderModelsService({
    cachePath: createEphemeralCachePath(),
    resolveProvider: (provider) => {
      calls.push(provider);
      return {
        models: {
          getSupportedModels: async () => createModels(`${provider}-models`),
          getCurrentActiveModel: async () => createCurrentActiveModel(`${provider}-active`),
          changeActiveModel: async (input) => createSessionActiveModelChange(provider, input),
        },
      };
    },
  });

  const models = await service.getProviderModels('codex', { bypassCache: true });

  // Every resolution goes to the requested provider. The count is deliberately
  // not asserted: one lookup resolves the adapter more than once (catalog read
  // plus fingerprint read), which is an implementation detail of caching.
  assert.ok(calls.length > 0);
  assert.deepEqual([...new Set(calls)], ['codex']);
  assert.equal(models.models.DEFAULT, 'codex-models');
  assert.equal(models.cache.source, 'fresh');
});

test('provider models service returns each provider adapter result without rewriting it', async () => {
  const expectedModels: ProviderModelsDefinition = {
    OPTIONS: [
      { value: 'cursor-a', label: 'Cursor A' },
      { value: 'cursor-b', label: 'Cursor B' },
    ],
    DEFAULT: 'cursor-b',
  };

  const service = createProviderModelsService({
    cachePath: createEphemeralCachePath(),
    resolveProvider: () => ({
      models: {
        getSupportedModels: async () => expectedModels,
        getCurrentActiveModel: async () => createCurrentActiveModel('cursor-active'),
        changeActiveModel: async (input) => createSessionActiveModelChange('cursor', input),
      },
    }),
  });

  const models = await service.getProviderModels('cursor', { bypassCache: true });

  // Only the `isCustom` tag is added (custom rows are merged after the
  // adapter's own options); nothing else is rewritten.
  assert.deepEqual(models.models, {
    ...expectedModels,
    OPTIONS: expectedModels.OPTIONS.map((option) => ({ ...option, isCustom: false })),
  });
});

test('provider models are cached for the three-day ttl', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'provider-model-cache-ttl-'));
  let currentTime = 1_000;
  let loadCount = 0;

  try {
    const service = createProviderModelsService({
      cachePath: path.join(tempRoot, 'models-cache.json'),
      now: () => currentTime,
      resolveProvider: (provider) => ({
        models: {
          getSupportedModels: async () => {
            loadCount += 1;
            return createModels(`${provider}-${loadCount}`);
          },
          getCurrentActiveModel: async () => createCurrentActiveModel(`${provider}-active`),
          changeActiveModel: async (input) => createSessionActiveModelChange(provider, input),
        },
      }),
    });

    const first = await service.getProviderModels('codex');
    const cached = await service.getProviderModels('codex');
    assert.equal(loadCount, 1);
    assert.equal(cached.models.DEFAULT, first.models.DEFAULT);
    assert.equal(cached.cache.source, 'memory');

    currentTime += PROVIDER_MODELS_CACHE_TTL_MS - 1;
    await service.getProviderModels('codex');
    assert.equal(loadCount, 1);

    currentTime += 2;
    const refreshed = await service.getProviderModels('codex');
    assert.equal(loadCount, 2);
    assert.equal(refreshed.models.DEFAULT, 'codex-2');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('a provisional catalog is only cached for a minute', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'provider-model-cache-provisional-'));
  let currentTime = 1_000;
  let loadCount = 0;

  try {
    const service = createProviderModelsService({
      cachePath: path.join(tempRoot, 'models-cache.json'),
      now: () => currentTime,
      resolveProvider: () => ({
        models: {
          getSupportedModels: async () => {
            loadCount += 1;
            return { ...createModels(`opencode-${loadCount}`), PROVISIONAL: true };
          },
          getCurrentActiveModel: async () => createCurrentActiveModel('opencode-active'),
          changeActiveModel: async (input) => createSessionActiveModelChange('opencode', input),
        },
      }),
    });

    await service.getProviderModels('opencode');
    currentTime += PROVIDER_MODELS_PROVISIONAL_CACHE_TTL_MS - 1;
    await service.getProviderModels('opencode');
    assert.equal(loadCount, 1);

    currentTime += 2;
    const refreshed = await service.getProviderModels('opencode');
    assert.equal(loadCount, 2);
    assert.equal(refreshed.models.DEFAULT, 'opencode-2');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('a changed catalog fingerprint drops a cached entry before its ttl', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'provider-model-cache-fingerprint-'));
  const cachePath = path.join(tempRoot, 'models-cache.json');
  let fingerprint = 'config-v1';
  let loadCount = 0;

  const buildService = () => createProviderModelsService({
    cachePath,
    resolveProvider: (provider) => ({
      models: {
        getSupportedModels: async () => {
          loadCount += 1;
          return createModels(`${provider}-${loadCount}`);
        },
        getCurrentActiveModel: async () => createCurrentActiveModel(`${provider}-active`),
        changeActiveModel: async (input) => createSessionActiveModelChange(provider, input),
        getCatalogFingerprint: async () => fingerprint,
      },
    }),
  });

  try {
    const service = buildService();
    const first = await service.getProviderModels('opencode');
    assert.equal(first.models.DEFAULT, 'opencode-1');
    assert.equal((await service.getProviderModels('opencode')).models.DEFAULT, 'opencode-1');
    assert.equal(loadCount, 1);

    // The user edits opencode.json: the cached catalog may now name models the
    // provider no longer serves, so the TTL must not keep it alive.
    fingerprint = 'config-v2';
    const refreshed = await service.getProviderModels('opencode');
    assert.equal(refreshed.models.DEFAULT, 'opencode-2');
    assert.equal(loadCount, 2);

    // The persisted copy is fingerprinted too, so a restart does not resurrect
    // the stale list from disk.
    fingerprint = 'config-v3';
    const restarted = await buildService().getProviderModels('opencode');
    assert.equal(restarted.models.DEFAULT, 'opencode-3');
    assert.equal(restarted.cache.source, 'fresh');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('claude provider models are always loaded directly from the provider', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'provider-model-cache-claude-direct-'));
  let loadCount = 0;

  try {
    const service = createProviderModelsService({
      cachePath: path.join(tempRoot, 'models-cache.json'),
      resolveProvider: (provider) => ({
        models: {
          getSupportedModels: async () => {
            loadCount += 1;
            return createModels(`${provider}-${loadCount}`);
          },
          getCurrentActiveModel: async () => createCurrentActiveModel(`${provider}-active`),
          changeActiveModel: async (input) => createSessionActiveModelChange(provider, input),
        },
      }),
    });

    const first = await service.getProviderModels('claude');
    const second = await service.getProviderModels('claude');

    assert.equal(loadCount, 2);
    assert.equal(first.models.DEFAULT, 'claude-1');
    assert.equal(second.models.DEFAULT, 'claude-2');
    assert.equal(second.cache.source, 'fresh');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('provider model cache is persisted across service instances', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'provider-model-cache-file-'));
  const cachePath = path.join(tempRoot, 'models-cache.json');

  try {
    const writer = createProviderModelsService({
      cachePath,
      resolveProvider: () => ({
        models: {
          getSupportedModels: async () => createModels('cursor-cached'),
          getCurrentActiveModel: async () => createCurrentActiveModel('cursor-active'),
          changeActiveModel: async (input) => createSessionActiveModelChange('cursor', input),
        },
      }),
    });
    await writer.getProviderModels('cursor');

    const reader = createProviderModelsService({
      cachePath,
      resolveProvider: () => ({
        models: {
          getSupportedModels: async () => {
            throw new Error('loader should not be called for persisted cache hits');
          },
          getCurrentActiveModel: async () => createCurrentActiveModel('cursor-active'),
          changeActiveModel: async (input) => createSessionActiveModelChange('cursor', input),
        },
      }),
    });
    const models = await reader.getProviderModels('cursor');
    assert.equal(models.models.DEFAULT, 'cursor-cached');
    assert.equal(models.cache.source, 'disk');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('concurrent provider model requests share one load operation', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'provider-model-cache-pending-'));
  let loadCount = 0;

  try {
    const service = createProviderModelsService({
      cachePath: path.join(tempRoot, 'models-cache.json'),
      resolveProvider: () => ({
        models: {
          getSupportedModels: async () => {
            loadCount += 1;
            await new Promise((resolve) => setTimeout(resolve, 20));
            return createModels('claude-cached');
          },
          getCurrentActiveModel: async () => createCurrentActiveModel('claude-active'),
          changeActiveModel: async (input) => createSessionActiveModelChange('claude', input),
        },
      }),
    });

    const [first, second] = await Promise.all([
      service.getProviderModels('claude'),
      service.getProviderModels('claude'),
    ]);

    assert.equal(loadCount, 1);
    assert.equal(first.models.DEFAULT, 'claude-cached');
    assert.equal(second.models.DEFAULT, 'claude-cached');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('bypassCache forces a fresh provider fetch and updates cache metadata', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'provider-model-cache-refresh-'));
  let currentTime = 1_000;
  let loadCount = 0;

  try {
    const service = createProviderModelsService({
      cachePath: path.join(tempRoot, 'models-cache.json'),
      now: () => currentTime,
      resolveProvider: (provider) => ({
        models: {
          getSupportedModels: async () => {
            loadCount += 1;
            return createModels(`${provider}-${loadCount}`);
          },
          getCurrentActiveModel: async () => createCurrentActiveModel(`${provider}-active-${loadCount}`),
          changeActiveModel: async (input) => createSessionActiveModelChange(provider, input),
        },
      }),
    });

    const first = await service.getProviderModels('claude');
    currentTime += 50;
    const refreshed = await service.getProviderModels('claude', { bypassCache: true });

    assert.equal(first.models.DEFAULT, 'claude-1');
    assert.equal(refreshed.models.DEFAULT, 'claude-2');
    assert.equal(refreshed.cache.source, 'fresh');
    assert.notEqual(refreshed.cache.updatedAt, first.cache.updatedAt);
    assert.equal(loadCount, 2);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('provider models service delegates current active model lookups to the provider adapter', async () => {
  const calls: Array<{ provider: LLMProvider; sessionId?: string }> = [];
  const service = createProviderModelsService({
    resolveProvider: (provider) => ({
      models: {
        getSupportedModels: async () => createModels(`${provider}-models`),
        getCurrentActiveModel: async (sessionId) => {
          calls.push({ provider, sessionId });
          return createCurrentActiveModel(`${provider}-${sessionId}`);
        },
        changeActiveModel: async (input) => createSessionActiveModelChange(provider, input),
      },
    }),
  });

  const activeModel = await service.getCurrentActiveModel('opencode', 'session-123');

  assert.deepEqual(calls, [{ provider: 'opencode', sessionId: 'session-123' }]);
  assert.equal(activeModel.model, 'opencode-session-123');
});

test('provider models service delegates active model change requests to the provider adapter', async () => {
  const calls: Array<{ provider: LLMProvider; input: ProviderChangeActiveModelInput }> = [];
  const service = createProviderModelsService({
    resolveProvider: (provider) => ({
      models: {
        getSupportedModels: async () => createModels(`${provider}-models`),
        getCurrentActiveModel: async () => createCurrentActiveModel(`${provider}-active`),
        changeActiveModel: async (input) => {
          calls.push({ provider, input });
          return createSessionActiveModelChange(provider, input);
        },
      },
    }),
  });

  const changedModel = await service.changeActiveModel('claude', {
    sessionId: 'session-123',
    model: 'opus',
  });

  assert.deepEqual(calls, [{
    provider: 'claude',
    input: {
      sessionId: 'session-123',
      model: 'opus',
    },
  }]);
  assert.equal(changedModel.changed, true);
  assert.equal(changedModel.model, 'opus');
});

test('resolveSessionActiveModel reports the override, the transcript model, then the default', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'provider-active-model-'));
  const activeModelChangesPath = path.join(tempRoot, 'session-model-changes.json');

  try {
    const service = createProviderModelsService({
      cachePath: createEphemeralCachePath(),
      activeModelChangesPath,
      resolveProvider: (provider) => ({
        models: {
          getSupportedModels: async () => createModels(`${provider}-default`),
          getCurrentActiveModel: async (sessionId) => createCurrentActiveModel(
            sessionId ? `${provider}-${sessionId}` : `${provider}-default`,
          ),
          changeActiveModel: async (input) => createSessionActiveModelChange(provider, input),
        },
      }),
    });

    await writeProviderSessionActiveModelChange('claude', {
      sessionId: 'session-pinned',
      model: 'fable',
    }, {
      filePath: activeModelChangesPath,
    });

    // A picker change that no turn has consumed yet still outranks the
    // transcript — that is the model the next turn will run on.
    assert.deepEqual(
      await service.resolveSessionActiveModel('claude', 'session-pinned'),
      { model: 'fable', overridden: true },
    );

    assert.deepEqual(
      await service.resolveSessionActiveModel('claude', 'session-plain'),
      { model: 'claude-session-plain', overridden: false },
    );

    assert.deepEqual(
      await service.resolveSessionActiveModel('claude', null),
      { model: 'claude-default', overridden: false },
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('resolveResumeModel prefers a stored changed model over the requested one', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'provider-model-change-'));
  const activeModelChangesPath = path.join(tempRoot, 'session-model-changes.json');

  try {
    const service = createProviderModelsService({
      activeModelChangesPath,
      resolveProvider: (provider) => ({
        models: {
          getSupportedModels: async () => createModels(`${provider}-models`),
          getCurrentActiveModel: async () => createCurrentActiveModel(`${provider}-active`),
          changeActiveModel: async (input) => createSessionActiveModelChange(provider, input),
        },
      }),
    });

    await writeProviderSessionActiveModelChange('cursor', {
      sessionId: 'session-456',
      model: 'composer-2',
    }, {
      filePath: activeModelChangesPath,
    });

    const model = await service.resolveResumeModel('cursor', 'session-456', 'composer-2-fast');
    assert.equal(model, 'composer-2');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('resolveResumeModel leaves a resumed session on its own model', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'provider-model-resume-'));
  const activeModelChangesPath = path.join(tempRoot, 'session-model-changes.json');

  try {
    const service = createProviderModelsService({
      activeModelChangesPath,
      resolveProvider: (provider) => ({
        models: {
          getSupportedModels: async () => createModels(`${provider}-models`),
          getCurrentActiveModel: async () => createCurrentActiveModel(`${provider}-active`),
          changeActiveModel: async (input) => createSessionActiveModelChange(provider, input),
        },
      }),
    });

    // The composer sends its per-provider picker model on every turn. On a
    // conversation that already ran, that is not a request to switch — honoring
    // it dragged every session onto whatever was last picked elsewhere.
    // The requested model is a *valid* catalog entry — without the guard it
    // would be forwarded, which is exactly the switch nobody asked for.
    const resumed = await service.resolveResumeModel('claude', 'session-789', 'claude-models', {
      resuming: true,
    });
    assert.equal(resumed, undefined);

    // A brand-new conversation still starts on the picker default.
    const fresh = await service.resolveResumeModel('claude', 'session-789', 'claude-models');
    assert.equal(fresh, 'claude-models');

    // An explicit per-session override still moves a resumed session.
    await writeProviderSessionActiveModelChange('claude', {
      sessionId: 'session-789',
      model: 'fable',
    }, {
      filePath: activeModelChangesPath,
    });

    const overridden = await service.resolveResumeModel('claude', 'session-789', 'claude-models', {
      resuming: true,
    });
    assert.equal(overridden, 'fable');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Custom models + session-row selection (upstream cloudcli 1.37 suite), run
// against the same service with ephemeral cache/change files.
// ---------------------------------------------------------------------------

/** In-memory stand-in for the `sessions` table rows the service reads and writes. */
const createSessionStore = (
  rows: Record<string, string | null> = {},
  efforts: Record<string, string | null> = {},
) => {
  const sessions = new Map(Object.entries(rows).map(([sessionId, model]) => [
    sessionId,
    { model, effort: efforts[sessionId] ?? null },
  ]));
  return {
    sessions,
    getSessionById: (sessionId: string) =>
      sessions.get(sessionId) ?? null,
    setSessionModel: (sessionId: string, model: string) => {
      const session = sessions.get(sessionId);
      if (session) {
        session.model = model;
      }
    },
    setSessionEffort: (sessionId: string, effort: string) => {
      const session = sessions.get(sessionId);
      if (session) {
        session.effort = effort;
      }
    },
  };
};

const createCatalogStore = () => {
  const rows = new Map<LLMProvider, CustomProviderModelRecord[]>();
  let nextRecordId = 1;
  const readRows = (provider: LLMProvider) => rows.get(provider) ?? [];

  return {
    rows,
    listCustomProviderModels(provider: LLMProvider) {
      return [...readRows(provider)];
    },
    getCustomProviderModel(provider: LLMProvider, recordId: number) {
      return readRows(provider).find((record) => record.recordId === recordId) ?? null;
    },
    findCustomProviderModelByModelId(provider: LLMProvider, modelId: string) {
      return readRows(provider).find((record) => record.modelId === modelId) ?? null;
    },
    createCustomProviderModel(provider: LLMProvider, input: CustomProviderModelInput) {
      const record: CustomProviderModelRecord = {
        recordId: nextRecordId++,
        provider,
        modelId: input.id,
        model: input.model,
        sortOrder: readRows(provider).length,
      };
      rows.set(provider, [...readRows(provider), record]);
      return record;
    },
    updateCustomProviderModel(
      provider: LLMProvider,
      recordId: number,
      input: CustomProviderModelInput,
    ) {
      const existing = readRows(provider).find((record) => record.recordId === recordId);
      if (!existing) {
        return null;
      }
      const updated = { ...existing, modelId: input.id, model: input.model };
      rows.set(provider, readRows(provider).map((record) => (
        record.recordId === recordId ? updated : record
      )));
      return updated;
    },
    deleteCustomProviderModel(provider: LLMProvider, recordId: number, _fallbackModelId: string) {
      const existing = readRows(provider).find((record) => record.recordId === recordId);
      if (!existing) {
        return null;
      }
      rows.set(provider, readRows(provider).filter((record) => record.recordId !== recordId));
      return existing;
    },
  };
};

const createTestService = (options: {
  catalog?: ReturnType<typeof createCatalogStore>;
  sessions?: ReturnType<typeof createSessionStore>;
  activeModel?: (provider: LLMProvider, sessionId?: string) => string;
  onCatalogRead?: (provider: LLMProvider) => void;
} = {}) => {
  const catalog = options.catalog ?? createCatalogStore();
  const sessions = options.sessions ?? createSessionStore();
  const service = createProviderModelsService({
    catalog,
    sessions,
    cachePath: createEphemeralCachePath(),
    activeModelChangesPath: createEphemeralCachePath(),
    resolveProvider: (provider) => ({
      models: {
        getSupportedModels: async () => {
          options.onCatalogRead?.(provider);
          return createModels(`${provider}-default`);
        },
        getCurrentActiveModel: async (sessionId) => createCurrentActiveModel(
          options.activeModel?.(provider, sessionId) ?? `${provider}-default`,
        ),
        changeActiveModel: async (input) => createSessionActiveModelChange(provider, input),
      },
    }),
  });

  return { service, catalog, sessions };
};

test('provider catalogs merge source-controlled defaults with custom persistence rows', async () => {
  const calls: LLMProvider[] = [];
  const { service, catalog } = createTestService({ onCatalogRead: (provider) => calls.push(provider) });

  const { models } = await service.getProviderModels('codex');

  assert.deepEqual(calls, ['codex']);
  assert.equal(models.DEFAULT, 'codex-default');
  assert.deepEqual(models.OPTIONS[0], {
    value: 'codex-default',
    label: 'codex-default',
    isCustom: false,
  });
  assert.deepEqual(catalog.rows.get('codex'), undefined);
});

test('custom models can be created, edited, and deleted', async () => {
  const { service } = createTestService();
  const created = await service.createCustomModel('claude', {
    model: 'My Claude',
    id: 'claude-my-model',
  });
  const recordId = created.model.recordId as number;

  assert.equal(created.model.isCustom, true);
  assert.equal(created.models.OPTIONS.at(-1)?.value, 'claude-my-model');

  const updated = await service.updateCustomModel('claude', recordId, {
    model: 'My Better Claude',
    id: 'claude-my-model-v2',
  });
  assert.equal(updated.model.label, 'My Better Claude');
  assert.equal(updated.model.value, 'claude-my-model-v2');

  const removed = await service.deleteCustomModel('claude', recordId);
  assert.equal(removed.model.value, 'claude-my-model-v2');
  assert.equal(removed.models.OPTIONS.some((option) => option.recordId === recordId), false);
});

test('duplicate model ids are rejected within one provider', async () => {
  const { service } = createTestService();
  await service.createCustomModel('cursor', { model: 'First', id: 'custom-id' });

  await assert.rejects(
    () => service.createCustomModel('cursor', { model: 'Second', id: 'custom-id' }),
    (error) => error instanceof AppError
      && error.code === 'MODEL_ID_ALREADY_EXISTS'
      && error.statusCode === 409,
  );

  await assert.rejects(
    () => service.createCustomModel('cursor', {
      model: 'Duplicate built-in',
      id: 'cursor-default',
    }),
    (error) => error instanceof AppError
      && error.code === 'MODEL_ID_ALREADY_EXISTS'
      && error.statusCode === 409,
  );
});

test('predefined models have no database record or mutation target', async () => {
  const { service, catalog } = createTestService();
  const { models } = await service.getProviderModels('opencode');
  assert.equal(models.OPTIONS[0]?.recordId, undefined);
  assert.equal(models.OPTIONS[0]?.isCustom, false);
  assert.deepEqual(catalog.rows.get('opencode'), undefined);

  await assert.rejects(
    () => service.updateCustomModel('opencode', 999, { model: 'Changed', id: 'changed' }),
    (error) => error instanceof AppError && error.code === 'MODEL_NOT_FOUND',
  );
});

test('resolveSessionModel asks the provider adapter for the requested session', async () => {
  const calls: Array<{ provider: LLMProvider; sessionId?: string }> = [];
  const { service } = createTestService({
    sessions: createSessionStore({ 'session-123': null }),
    activeModel: (provider, sessionId) => {
      calls.push({ provider, sessionId });
      return `${provider}-${sessionId}`;
    },
  });

  const resolved = await service.resolveSessionModel('opencode', { sessionId: 'session-123' });

  assert.deepEqual(calls, [{ provider: 'opencode', sessionId: 'session-123' }]);
  assert.equal(resolved.model, 'opencode-session-123');
});

test('setSessionModel records the model on the session row', () => {
  const sessions = createSessionStore({ 'session-1': null });
  const { service } = createTestService({ sessions });

  const stored = service.setSessionModel('claude', 'session-1', 'opus');

  assert.deepEqual(stored, {
    provider: 'claude',
    sessionId: 'session-1',
    model: 'opus',
    effort: null,
    source: 'session',
  });
  assert.equal(sessions.sessions.get('session-1')?.model, 'opus');
});

test('setSessionModel ignores sessions that have no row yet', () => {
  const sessions = createSessionStore();
  const { service } = createTestService({ sessions });

  assert.equal(service.setSessionModel('claude', 'missing-session', 'opus'), null);
  assert.equal(sessions.sessions.size, 0);
});

test('setSessionEffort records an explicit effort on the session row', () => {
  const sessions = createSessionStore({ 'session-1': 'gpt-5.6-sol' });
  const { service } = createTestService({ sessions });

  const stored = service.setSessionEffort('codex', 'session-1', 'ultra');

  assert.deepEqual(stored, {
    provider: 'codex',
    sessionId: 'session-1',
    effort: 'ultra',
    source: 'session',
  });
  assert.equal(sessions.sessions.get('session-1')?.effort, 'ultra');
});

test('setSessionEffort ignores sessions that have no row yet', () => {
  const sessions = createSessionStore();
  const { service } = createTestService({ sessions });

  assert.equal(service.setSessionEffort('codex', 'missing-session', 'high'), null);
  assert.equal(sessions.sessions.size, 0);
});

test('resolveSessionModel prefers the recorded session model', async () => {
  const { service } = createTestService({
    sessions: createSessionStore({ 'session-1': 'haiku' }, { 'session-1': 'high' }),
    activeModel: () => 'provider-reported',
  });

  const resolved = await service.resolveSessionModel('claude', {
    sessionId: 'session-1',
    requestedModel: 'sonnet',
  });

  assert.equal(resolved.model, 'haiku');
  assert.equal(resolved.effort, 'high');
  assert.equal(resolved.source, 'session');
});

test('resolveSessionModel uses provider session state for unrecorded external sessions', async () => {
  const { service } = createTestService({
    sessions: createSessionStore({ 'session-1': null }),
    activeModel: () => 'provider-reported',
  });

  const resolved = await service.resolveSessionModel('opencode', {
    sessionId: 'session-1',
    requestedModel: 'requested',
  });

  assert.equal(resolved.model, 'provider-reported');
  assert.equal(resolved.source, 'provider');
});

test('resolveSessionModel uses the requested model when provider reports the catalog default', async () => {
  const { service } = createTestService({
    sessions: createSessionStore({ 'session-1': null }),
  });

  const resolved = await service.resolveSessionModel('claude', {
    sessionId: 'session-1',
    requestedModel: 'haiku',
  });

  assert.equal(resolved.model, 'haiku');
  assert.equal(resolved.source, 'session');
});

test('resolveSessionModel returns a requested model before a session exists', async () => {
  const { service } = createTestService();

  const resolved = await service.resolveSessionModel('codex', { requestedModel: 'gpt-5.5' });

  assert.equal(resolved.model, 'gpt-5.5');
  assert.equal(resolved.sessionId, null);
  assert.equal(resolved.source, 'session');
});

test('resolveSessionModel falls back to the provider adapter default', async () => {
  const { service } = createTestService();

  const resolved = await service.resolveSessionModel('codex');

  assert.equal(resolved.model, 'codex-default');
  assert.equal(resolved.source, 'default');
});

test('resolveResumeModel prefers the recorded session model over the requested one', async () => {
  const { service } = createTestService({
    sessions: createSessionStore({ 'session-456': 'composer-2' }),
  });

  const model = await service.resolveResumeModel('cursor', 'session-456', 'composer-2-fast');
  assert.equal(model, 'composer-2');
});

test('resolveResumeModel never consults provider-global state', async () => {
  let providerLookups = 0;
  const { service } = createTestService({
    sessions: createSessionStore({ 'session-456': null }),
    activeModel: () => {
      providerLookups += 1;
      return 'global-config-model';
    },
  });

  // Only a catalog-listed request survives (a foreign alias is dropped), and
  // the provider's own state is never asked either way.
  const model = await service.resolveResumeModel('codex', 'session-456', 'codex-default');

  assert.equal(model, 'codex-default');
  assert.equal(providerLookups, 0);
  assert.equal(await service.resolveResumeModel('codex', 'session-456', 'gpt-5.5'), undefined);
  assert.equal(providerLookups, 0);
});
