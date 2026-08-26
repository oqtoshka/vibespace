import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { providerModelsDb, sessionsDb } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import type { IProvider } from '@/shared/interfaces.js';
import type {
  CustomProviderModelInput,
  CustomProviderModelRecord,
  LLMProvider,
  ProviderChangeActiveModelInput,
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsCacheInfo,
  ProviderModelsDefinition,
  ProviderModelsResult,
  ProviderSessionActiveModelChange,
  ProviderSessionModel,
} from '@/shared/types.js';
import { AppError, readProviderSessionActiveModelChange } from '@/shared/utils.js';

export const PROVIDER_MODELS_CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000;
/**
 * A catalog the adapter flagged as a guess (`PROVISIONAL`) is held only long
 * enough to keep a burst of composer lookups from re-spawning the provider CLI.
 * Holding it for the full TTL would outlive whatever made the real read fail.
 */
export const PROVIDER_MODELS_PROVISIONAL_CACHE_TTL_MS = 60 * 1000;
const PROVIDER_MODELS_CACHE_VERSION = 2;
const UNCACHED_PROVIDERS = new Set<LLMProvider>(['claude']);

/** Session-row access the service needs, narrowed so tests can stub it. */
type ProviderModelsSessionStore = {
  getSessionById(sessionId: string): { model: string | null; effort: string | null } | null;
  setSessionModel(sessionId: string, model: string): void;
  setSessionEffort(sessionId: string, effort: string): void;
};

/** SQLite catalog operations used by the Providers service and its unit fakes. */
type ProviderModelsCatalogStore = Pick<
  typeof providerModelsDb,
  | 'listCustomProviderModels'
  | 'getCustomProviderModel'
  | 'findCustomProviderModelByModelId'
  | 'createCustomProviderModel'
  | 'updateCustomProviderModel'
  | 'deleteCustomProviderModel'
>;

type ProviderModelsServiceDependencies = {
  resolveProvider?: (provider: LLMProvider) => Pick<IProvider, 'models'>;
  cachePath?: string;
  activeModelChangesPath?: string;
  now?: () => number;
  /** Custom (user-managed) model rows; defaults to the SQLite repository. */
  catalog?: ProviderModelsCatalogStore;
  /** Session rows carrying the per-session model/effort selection. */
  sessions?: ProviderModelsSessionStore;
};

const toCustomProviderModelOption = (
  record: CustomProviderModelRecord,
): ProviderModelOption => ({
  value: record.modelId,
  label: record.model,
  recordId: record.recordId,
  isCustom: true,
});

/**
 * Curated adapter options first, then the user's custom rows. Everything else
 * on the definition (`DEFAULT`, `PROVISIONAL`) is carried through untouched.
 */
const mergeProviderModels = (
  predefined: ProviderModelsDefinition,
  custom: CustomProviderModelRecord[],
): ProviderModelsDefinition => ({
  ...predefined,
  OPTIONS: [
    ...predefined.OPTIONS.map((option) => ({ ...option, isCustom: false })),
    ...custom.map(toCustomProviderModelOption),
  ],
  DEFAULT: predefined.DEFAULT,
});

const normalizeCustomModelInput = (input: CustomProviderModelInput): CustomProviderModelInput => ({
  id: input.id.trim(),
  model: input.model.trim(),
});

const isUniqueConstraintError = (error: unknown): boolean => (
  error !== null
  && error !== undefined
  && typeof error === 'object'
  && 'code' in error
  && String(error.code).startsWith('SQLITE_CONSTRAINT')
);

type ProviderModelsOptions = {
  bypassCache?: boolean;
};

type ProviderModelsCacheEntry = {
  updatedAt: number;
  expiresAt: number;
  models: ProviderModelsDefinition;
  /**
   * Provider-reported token for the inputs the catalog was built from (see
   * `IProviderModels.getCatalogFingerprint`). A cached entry whose fingerprint
   * no longer matches is stale regardless of its TTL. Absent for providers that
   * do not report one, and for entries written before this field existed.
   */
  fingerprint?: string | null;
};

type ProviderModelsCacheFile = {
  version: number;
  entries: Record<string, ProviderModelsCacheEntry>;
};

const getProviderModelsCachePath = (): string => path.join(
  os.homedir(),
  '.vibespace',
  'provider-models-cache.json',
);

const toProviderModelsCacheInfo = (
  entry: ProviderModelsCacheEntry,
  source: ProviderModelsCacheInfo['source'],
): ProviderModelsCacheInfo => ({
  updatedAt: new Date(entry.updatedAt).toISOString(),
  expiresAt: new Date(entry.expiresAt).toISOString(),
  source,
});

const isProviderModelOption = (
  value: unknown,
): value is ProviderModelsDefinition['OPTIONS'][number] => (
  Boolean(value)
  && typeof value === 'object'
  && typeof (value as ProviderModelsDefinition['OPTIONS'][number]).value === 'string'
  && typeof (value as ProviderModelsDefinition['OPTIONS'][number]).label === 'string'
  && (
    typeof (value as ProviderModelsDefinition['OPTIONS'][number]).description === 'undefined'
    || typeof (value as ProviderModelsDefinition['OPTIONS'][number]).description === 'string'
  )
);

const isProviderModelsDefinition = (value: unknown): value is ProviderModelsDefinition => (
  Boolean(value)
  && typeof value === 'object'
  && Array.isArray((value as ProviderModelsDefinition).OPTIONS)
  && (value as ProviderModelsDefinition).OPTIONS.every(isProviderModelOption)
  && typeof (value as ProviderModelsDefinition).DEFAULT === 'string'
);

const isProviderModelsCacheEntry = (value: unknown): value is ProviderModelsCacheEntry => (
  Boolean(value)
  && typeof value === 'object'
  && typeof (value as ProviderModelsCacheEntry).updatedAt === 'number'
  && typeof (value as ProviderModelsCacheEntry).expiresAt === 'number'
  && isProviderModelsDefinition((value as ProviderModelsCacheEntry).models)
  && (
    (value as ProviderModelsCacheEntry).fingerprint === undefined
    || (value as ProviderModelsCacheEntry).fingerprint === null
    || typeof (value as ProviderModelsCacheEntry).fingerprint === 'string'
  )
);

const readProviderModelsCacheFile = async (
  cachePath: string,
): Promise<ProviderModelsCacheFile | null> => {
  try {
    const raw = await readFile(cachePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<ProviderModelsCacheFile>;
    if (parsed.version !== PROVIDER_MODELS_CACHE_VERSION || !parsed.entries || typeof parsed.entries !== 'object') {
      return null;
    }

    const entries = Object.fromEntries(
      Object.entries(parsed.entries).filter((entry): entry is [string, ProviderModelsCacheEntry] =>
        isProviderModelsCacheEntry(entry[1]),
      ),
    );

    return {
      version: PROVIDER_MODELS_CACHE_VERSION,
      entries,
    };
  } catch {
    return null;
  }
};

const writeProviderModelsCacheFile = async (
  cachePath: string,
  entries: Map<LLMProvider, ProviderModelsCacheEntry>,
  now: number,
): Promise<void> => {
  const serializableEntries = Object.fromEntries(
    [...entries.entries()].filter(([, entry]) => entry.expiresAt > now),
  );
  const payload: ProviderModelsCacheFile = {
    version: PROVIDER_MODELS_CACHE_VERSION,
    entries: serializableEntries,
  };

  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
};

/**
 * Provider model lookup service.
 *
 * Routes and other service callers use this layer instead of resolving provider
 * classes directly so the provider-registry dependency stays centralized in one
 * place.
 *
 * Two catalogs meet here: the adapter's own list (cached on disk with a TTL and
 * a config fingerprint — OpenCode's is read from the CLI, so it is not free)
 * and the user's custom rows in SQLite, merged at read time. Per-session
 * selection lives in two places as well: the session row (`setSessionModel` /
 * `setSessionEffort`, what the composer last sent) and the change file
 * (`changeActiveModel`, a `/model` switch waiting for the next turn); the
 * change file wins because it is the later intent.
 */
export const createProviderModelsService = (dependencies: ProviderModelsServiceDependencies = {}) => {
  // Resolved per call, not captured at construction: the shared instance is
  // built at module load, and this module sits on an import cycle with the
  // registry (registry -> provider -> runtime wrapper -> runtime impl -> here),
  // so `providerRegistry` may still be in its TDZ when this runs.
  const resolveProvider = (provider: LLMProvider): Pick<IProvider, 'models'> => (
    dependencies.resolveProvider ?? providerRegistry.resolveProvider
  )(provider);
  const catalog = dependencies.catalog ?? providerModelsDb;
  const sessions = dependencies.sessions ?? sessionsDb;
  const cachePath = dependencies.cachePath ?? getProviderModelsCachePath();
  const activeModelChangesPath = dependencies.activeModelChangesPath;
  const now = dependencies.now ?? (() => Date.now());
  const memoryCache = new Map<LLMProvider, ProviderModelsCacheEntry>();
  const pendingRequests = new Map<LLMProvider, Promise<ProviderModelsResult>>();
  let persistedCacheLoaded = false;
  let persistedCacheLoadPromise: Promise<void> | null = null;

  /**
   * Reads the provider's catalog fingerprint, or null when it does not report
   * one. A provider that throws here must not take the whole lookup down — the
   * caller then behaves exactly as it did before fingerprints existed.
   */
  const readCatalogFingerprint = async (provider: LLMProvider): Promise<string | null> => {
    try {
      return await resolveProvider(provider).models.getCatalogFingerprint?.() ?? null;
    } catch (error) {
      console.warn(`Unable to read ${provider} model catalog fingerprint:`, error);
      return null;
    }
  };

  const pruneExpiredMemoryEntry = (
    provider: LLMProvider,
    currentTime: number,
    source: ProviderModelsCacheInfo['source'],
    fingerprint: string | null,
  ): ProviderModelsResult | null => {
    const cachedEntry = memoryCache.get(provider);
    if (!cachedEntry) {
      return null;
    }

    // A fingerprint mismatch outranks the TTL: the config the catalog was read
    // from has changed, so the cached list may name models the provider no
    // longer accepts. `?? null` normalizes entries written before the field.
    const isCurrent = (cachedEntry.fingerprint ?? null) === fingerprint;
    if (isCurrent && cachedEntry.expiresAt > currentTime) {
      return {
        models: cachedEntry.models,
        cache: toProviderModelsCacheInfo(cachedEntry, source),
      };
    }

    memoryCache.delete(provider);
    return null;
  };

  const loadPersistedCache = async (): Promise<void> => {
    if (persistedCacheLoaded) {
      return;
    }

    if (!persistedCacheLoadPromise) {
      persistedCacheLoadPromise = (async () => {
        const cacheFile = await readProviderModelsCacheFile(cachePath);
        const currentTime = now();

        for (const [provider, entry] of Object.entries(cacheFile?.entries ?? {})) {
          if (entry.expiresAt > currentTime) {
            memoryCache.set(provider as LLMProvider, entry);
          }
        }

        persistedCacheLoaded = true;
      })().finally(() => {
        persistedCacheLoadPromise = null;
      });
    }

    await persistedCacheLoadPromise;
  };

  const persistCache = async (): Promise<void> => {
    try {
      await writeProviderModelsCacheFile(cachePath, memoryCache, now());
    } catch (error) {
      console.warn('Unable to persist provider models cache:', error);
    }
  };

  const setCacheEntry = async (
    provider: LLMProvider,
    models: ProviderModelsDefinition,
    fingerprint: string | null,
  ): Promise<ProviderModelsCacheEntry> => {
    const currentTime = now();
    const ttl = models.PROVISIONAL
      ? PROVIDER_MODELS_PROVISIONAL_CACHE_TTL_MS
      : PROVIDER_MODELS_CACHE_TTL_MS;
    const entry: ProviderModelsCacheEntry = {
      updatedAt: currentTime,
      expiresAt: currentTime + ttl,
      models,
      fingerprint,
    };

    memoryCache.set(provider, entry);
    await persistCache();
    return entry;
  };

  const loadAndCacheModels = (
    provider: LLMProvider,
    // Read before the catalog, not after: a config edit that lands mid-fetch
    // then leaves a fingerprint the next lookup rejects, instead of stamping
    // the new fingerprint onto a catalog read from the old config.
    fingerprint: string | null,
  ): Promise<ProviderModelsResult> => {
    const request = resolveProvider(provider).models.getSupportedModels()
      .then(async (models) => {
        const entry = await setCacheEntry(provider, models, fingerprint);
        return {
          models,
          cache: toProviderModelsCacheInfo(entry, 'fresh'),
        };
      })
      .finally(() => {
        pendingRequests.delete(provider);
      });

    pendingRequests.set(provider, request);
    return request;
  };

  const loadDirectModels = (
    provider: LLMProvider,
  ): Promise<ProviderModelsResult> => {
    const request = resolveProvider(provider).models.getSupportedModels()
      .then((models) => {
        const currentTime = now();
        return {
          models,
          cache: {
            updatedAt: new Date(currentTime).toISOString(),
            expiresAt: new Date(currentTime).toISOString(),
            source: 'fresh' as const,
          },
        };
      })
      .finally(() => {
        pendingRequests.delete(provider);
      });

    pendingRequests.set(provider, request);
    return request;
  };

  const getPredefinedProviderModels = async (
    provider: LLMProvider,
    options: ProviderModelsOptions = {},
  ): Promise<ProviderModelsResult> => {
    if (UNCACHED_PROVIDERS.has(provider)) {
      const pendingRequest = pendingRequests.get(provider);
      if (pendingRequest) {
        return pendingRequest;
      }

      return loadDirectModels(provider);
    }

    const fingerprint = await readCatalogFingerprint(provider);

    if (options.bypassCache) {
      const pendingRequest = pendingRequests.get(provider);
      if (pendingRequest) {
        return pendingRequest;
      }

      return loadAndCacheModels(provider, fingerprint);
    }

    const cachedModels = pruneExpiredMemoryEntry(provider, now(), 'memory', fingerprint);
    if (cachedModels) {
      return cachedModels;
    }

    const pendingRequest = pendingRequests.get(provider);
    if (pendingRequest) {
      return pendingRequest;
    }

    await loadPersistedCache();

    const persistedModels = pruneExpiredMemoryEntry(provider, now(), 'disk', fingerprint);
    if (persistedModels) {
      return persistedModels;
    }

    const postLoadPendingRequest = pendingRequests.get(provider);
    if (postLoadPendingRequest) {
      return postLoadPendingRequest;
    }

    return loadAndCacheModels(provider, fingerprint);
  };

  const customModelsUnavailable = new Set<LLMProvider>();
  const listCustomModels = (provider: LLMProvider): CustomProviderModelRecord[] => {
    try {
      return catalog.listCustomProviderModels(provider);
    } catch (error) {
      // No database (a unit test with a fake registry, a CLI helper) must not
      // take the curated catalog down with it. Say so once per provider.
      if (!customModelsUnavailable.has(provider)) {
        customModelsUnavailable.add(provider);
        console.warn(`Unable to read custom ${provider} models:`, error instanceof Error ? error.message : error);
      }
      return [];
    }
  };

  const getProviderModels = async (
    provider: LLMProvider,
    options: ProviderModelsOptions = {},
  ): Promise<ProviderModelsResult> => {
    const result = await getPredefinedProviderModels(provider, options);
    return {
      ...result,
      models: mergeProviderModels(result.models, listCustomModels(provider)),
    };
  };

  const readCustomModel = (
    provider: LLMProvider,
    recordId: number,
  ): CustomProviderModelRecord => {
    const existing = catalog.getCustomProviderModel(provider, recordId);
    if (!existing) {
      throw new AppError('Model not found.', {
        code: 'MODEL_NOT_FOUND',
        statusCode: 404,
      });
    }

    return existing;
  };

  const assertModelIdAvailable = (
    provider: LLMProvider,
    predefined: ProviderModelsDefinition,
    modelId: string,
    currentRecordId?: number,
  ): void => {
    if (predefined.OPTIONS.some((option) => option.value === modelId)) {
      throw new AppError(`A ${provider} model with this ID already exists.`, {
        code: 'MODEL_ID_ALREADY_EXISTS',
        statusCode: 409,
      });
    }

    const duplicate = catalog.findCustomProviderModelByModelId(provider, modelId);
    if (duplicate && duplicate.recordId !== currentRecordId) {
      throw new AppError(`A ${provider} model with this ID already exists.`, {
        code: 'MODEL_ID_ALREADY_EXISTS',
        statusCode: 409,
      });
    }
  };

  const createCustomModel = async (
    provider: LLMProvider,
    input: CustomProviderModelInput,
  ): Promise<{ model: ProviderModelOption; models: ProviderModelsDefinition }> => {
    const { models: predefined } = await getPredefinedProviderModels(provider);
    const normalized = normalizeCustomModelInput(input);
    assertModelIdAvailable(provider, predefined, normalized.id);

    try {
      const created = catalog.createCustomProviderModel(provider, normalized);
      return {
        model: toCustomProviderModelOption(created),
        models: mergeProviderModels(predefined, catalog.listCustomProviderModels(provider)),
      };
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new AppError(`A ${provider} model with this ID already exists.`, {
          code: 'MODEL_ID_ALREADY_EXISTS',
          statusCode: 409,
        });
      }
      throw error;
    }
  };

  const updateCustomModel = async (
    provider: LLMProvider,
    recordId: number,
    input: CustomProviderModelInput,
  ): Promise<{ model: ProviderModelOption; models: ProviderModelsDefinition }> => {
    const { models: predefined } = await getPredefinedProviderModels(provider);
    readCustomModel(provider, recordId);
    const normalized = normalizeCustomModelInput(input);
    assertModelIdAvailable(provider, predefined, normalized.id, recordId);

    try {
      const updated = catalog.updateCustomProviderModel(provider, recordId, normalized);
      if (!updated) {
        throw new AppError('Model not found.', {
          code: 'MODEL_NOT_FOUND',
          statusCode: 404,
        });
      }

      return {
        model: toCustomProviderModelOption(updated),
        models: mergeProviderModels(predefined, catalog.listCustomProviderModels(provider)),
      };
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new AppError(`A ${provider} model with this ID already exists.`, {
          code: 'MODEL_ID_ALREADY_EXISTS',
          statusCode: 409,
        });
      }
      throw error;
    }
  };

  const deleteCustomModel = async (
    provider: LLMProvider,
    recordId: number,
  ): Promise<{ model: ProviderModelOption; models: ProviderModelsDefinition }> => {
    const { models: predefined } = await getPredefinedProviderModels(provider);
    readCustomModel(provider, recordId);
    const removed = catalog.deleteCustomProviderModel(provider, recordId, predefined.DEFAULT);
    if (!removed) {
      throw new AppError('Model not found.', {
        code: 'MODEL_NOT_FOUND',
        statusCode: 404,
      });
    }

    return {
      model: toCustomProviderModelOption(removed),
      models: mergeProviderModels(predefined, catalog.listCustomProviderModels(provider)),
    };
  };

  const readRecordedSessionSelection = (
    sessionId: string,
  ): { model: string | null; effort: string | null } | null => {
    let session: { model: string | null; effort: string | null } | null = null;
    try {
      session = sessions.getSessionById(sessionId);
    } catch {
      // DB unavailable (tests) — behave as if the row does not exist.
    }
    if (!session) {
      return null;
    }

    return {
      model: session.model?.trim() || null,
      effort: session.effort?.trim() || null,
    };
  };

  /**
   * Records the model one session runs with.
   *
   * Called from the active-model route when the user picks a model and from
   * `chat.send` on every turn, so the row always matches what the session last
   * ran with. Sessions the app has not created yet (no row) are ignored rather
   * than treated as an error: the client keeps its own pending selection and
   * the value lands on the row with the first send.
   */
  const setSessionModel = (
    provider: LLMProvider,
    sessionId: string,
    model: string,
  ): ProviderSessionModel | null => {
    const normalizedSessionId = sessionId.trim();
    const normalizedModel = model.trim();
    if (!normalizedSessionId || !normalizedModel) {
      return null;
    }

    const recordedSelection = readRecordedSessionSelection(normalizedSessionId);
    if (!recordedSelection) {
      return null;
    }

    sessions.setSessionModel(normalizedSessionId, normalizedModel);
    return {
      provider,
      sessionId: normalizedSessionId,
      model: normalizedModel,
      effort: recordedSelection.effort,
      source: 'session',
    };
  };

  /**
   * Records the reasoning effort one session runs with.
   *
   * Like `setSessionModel`, this ignores an id that has not been allocated by
   * the session gateway yet. The websocket send path records it once the row
   * exists, so a pre-session composer choice is not lost.
   */
  const setSessionEffort = (
    provider: LLMProvider,
    sessionId: string,
    effort: string,
  ): { provider: LLMProvider; sessionId: string; effort: string; source: 'session' } | null => {
    const normalizedSessionId = sessionId.trim();
    const normalizedEffort = effort.trim();
    if (!normalizedSessionId || !normalizedEffort) {
      return null;
    }

    if (!readRecordedSessionSelection(normalizedSessionId)) {
      return null;
    }

    sessions.setSessionEffort(normalizedSessionId, normalizedEffort);
    return {
      provider,
      sessionId: normalizedSessionId,
      effort: normalizedEffort,
      source: 'session',
    };
  };

  const getCurrentActiveModel = async (
    provider: LLMProvider,
    sessionId?: string,
  ): Promise<ProviderCurrentActiveModel> => resolveProvider(provider).models.getCurrentActiveModel(sessionId);

  const changeActiveModel = async (
    provider: LLMProvider,
    input: ProviderChangeActiveModelInput,
  ): Promise<ProviderSessionActiveModelChange> => resolveProvider(provider).models.changeActiveModel(input);

  /**
   * A session is addressable by two ids: the app-allocated `session_id` (what
   * the frontend/model-change endpoint uses) and the provider-native
   * `provider_session_id` (what the runtimes resume with). Overrides written
   * under one must be found when queried by the other, so expand to all known
   * aliases before reading the change cache.
   */
  const resolveSessionIdAliases = (sessionId: string): string[] => {
    const ids = new Set<string>([sessionId]);
    try {
      const row = sessionsDb.getSessionById(sessionId)
        ?? sessionsDb.getSessionByProviderSessionId(sessionId);
      if (row) {
        ids.add(row.session_id);
        if (row.provider_session_id) {
          ids.add(row.provider_session_id);
        }
      }
    } catch {
      // DB unavailable (tests) — fall back to the literal id.
    }
    return [...ids];
  };

  const getChangedActiveModel = async (
    provider: LLMProvider,
    sessionId: string,
  ): Promise<ProviderSessionActiveModelChange> => {
    let fallback: ProviderSessionActiveModelChange | null = null;
    for (const aliasId of resolveSessionIdAliases(sessionId)) {
      const change = await readProviderSessionActiveModelChange(provider, aliasId, {
        filePath: activeModelChangesPath,
      });
      if (change.changed && change.model) {
        return change;
      }
      fallback = fallback ?? change;
    }
    return fallback ?? readProviderSessionActiveModelChange(provider, sessionId, {
      filePath: activeModelChangesPath,
    });
  };

  /**
   * The model this session's *next* turn will actually run on.
   *
   * Consulted in the same order the resume path itself uses: a picker override
   * that has not been consumed by a turn yet, then the model the transcript
   * shows the session last ran on, then the catalog default. The composer
   * readout and the `/models` picker both resolve through here so they can
   * never disagree about what is selected.
   */
  const resolveSessionActiveModel = async (
    provider: LLMProvider,
    sessionId?: string | null,
  ): Promise<{ model: string; overridden: boolean }> => {
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';

    if (normalizedSessionId) {
      try {
        const changed = await getChangedActiveModel(provider, normalizedSessionId);
        if (changed.changed && changed.model?.trim()) {
          return { model: changed.model.trim(), overridden: true };
        }
      } catch {
        // Fall through to the transcript-backed lookup.
      }

      try {
        const current = await getCurrentActiveModel(provider, normalizedSessionId);
        if (current?.model?.trim()) {
          return { model: current.model.trim(), overridden: false };
        }
      } catch {
        // Fall through to the catalog default.
      }
    }

    const { models } = await getProviderModels(provider);
    return { model: models.DEFAULT, overridden: false };
  };

  /**
   * `resuming` marks a conversation that already has a model of its own — a
   * warm session, or a transcript being resumed.
   *
   * The composer rides its per-provider picker model on *every* turn, but that
   * value is only the default for NEW conversations. Applying it to a
   * conversation that already ran silently moved that session's model and made
   * the CLI announce a switch nobody asked for: pick Fable once and the next
   * message sent in any other session dragged it back to the stored default.
   * A conversation that already has a model is moved only by an explicit
   * per-session override.
   */
  /**
   * Answers "which model is this session using?" for every display surface.
   *
   * Precedence, highest first:
   *   1. a `/model` switch waiting for the next turn (the change file);
   *   2. the model recorded on the session row;
   *   3. the provider's own session state for externally-created sessions;
   *   4. `requestedModel`, the client's current default;
   *   5. the provider catalog default.
   */
  const resolveSessionModel = async (
    provider: LLMProvider,
    options: { sessionId?: string | null; requestedModel?: string | null } = {},
  ): Promise<ProviderSessionModel> => {
    const normalizedSessionId = typeof options.sessionId === 'string' ? options.sessionId.trim() : '';
    const normalizedRequestedModel = typeof options.requestedModel === 'string'
      ? options.requestedModel.trim()
      : '';

    if (normalizedSessionId) {
      const recordedSelection = readRecordedSessionSelection(normalizedSessionId);

      try {
        const changed = await getChangedActiveModel(provider, normalizedSessionId);
        if (changed.changed && changed.model?.trim()) {
          return {
            provider,
            sessionId: normalizedSessionId,
            model: changed.model.trim(),
            effort: recordedSelection?.effort ?? null,
            source: 'session',
          };
        }
      } catch {
        // Fall through to the row-backed lookup.
      }

      if (recordedSelection?.model) {
        return {
          provider,
          sessionId: normalizedSessionId,
          model: recordedSelection.model,
          effort: recordedSelection.effort,
          source: 'session',
        };
      }

      const { models: providerCatalog } = await getProviderModels(provider);
      const providerModel = await getCurrentActiveModel(provider, normalizedSessionId);
      const resolvedProviderModel = providerModel.model?.trim();
      if (resolvedProviderModel && resolvedProviderModel !== providerCatalog.DEFAULT) {
        return {
          provider,
          sessionId: normalizedSessionId,
          model: resolvedProviderModel,
          effort: recordedSelection?.effort ?? null,
          source: 'provider',
        };
      }

      return {
        provider,
        sessionId: normalizedSessionId,
        model: normalizedRequestedModel || providerCatalog.DEFAULT,
        effort: recordedSelection?.effort ?? null,
        source: normalizedRequestedModel ? 'session' : 'default',
      };
    }

    if (normalizedRequestedModel) {
      return {
        provider,
        sessionId: null,
        model: normalizedRequestedModel,
        effort: null,
        source: 'session',
      };
    }

    const { models: providerCatalog } = await getProviderModels(provider);
    return {
      provider,
      sessionId: null,
      model: providerCatalog.DEFAULT,
      effort: null,
      source: 'default',
    };
  };

  /**
   * Picks the model one resumed provider run should use.
   *
   * A pending `/model` switch wins, then the model recorded on the session row
   * (what the composer last sent for this session), then — for a NEW
   * conversation only — the client's request. Provider-global state is never
   * consulted: it must not override what was picked for this session.
   */
  const resolveResumeModel = async (
    provider: LLMProvider,
    sessionId: string | undefined,
    requestedModel?: string | null,
    { resuming = false }: { resuming?: boolean } = {},
  ): Promise<string | undefined> => {
    const normalizedRequestedModel = typeof requestedModel === 'string' ? requestedModel.trim() : '';
    if (!sessionId?.trim()) {
      return normalizedRequestedModel || undefined;
    }

    const changedModel = await getChangedActiveModel(provider, sessionId);
    if (changedModel.supported && changedModel.changed && changedModel.model?.trim()) {
      return changedModel.model.trim();
    }

    const recordedModel = readRecordedSessionSelection(sessionId.trim())?.model;
    if (recordedModel) {
      return recordedModel;
    }

    if (resuming || !normalizedRequestedModel) {
      return undefined;
    }

    // The client is not a trustworthy source for `model` — any provider mix-up
    // on its side used to forward a foreign alias (a Claude `opus` onto a codex
    // session) straight to the CLI, which then failed the whole run. Drop
    // anything the provider's own catalog does not list and let the provider
    // fall back to its default.
    const { models } = await getProviderModels(provider);
    const isKnownModel = models.OPTIONS.some(
      (option) => option.value === normalizedRequestedModel,
    );

    return isKnownModel ? normalizedRequestedModel : undefined;
  };

  const clearCache = (): void => {
    memoryCache.clear();
    pendingRequests.clear();
    persistedCacheLoaded = false;
    persistedCacheLoadPromise = null;
  };

  return {
    getProviderModels,
    getCurrentActiveModel,
    getChangedActiveModel,
    resolveSessionActiveModel,
    changeActiveModel,
    createCustomModel,
    updateCustomModel,
    deleteCustomModel,
    setSessionModel,
    setSessionEffort,
    resolveSessionModel,
    resolveResumeModel,
    clearCache,
  };
};

/** Shared Providers service used by routes, Commands, and provider runtimes. */
export const providerModelsService = createProviderModelsService();
