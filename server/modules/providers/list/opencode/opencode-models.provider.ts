import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import crossSpawn from 'cross-spawn';

import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderChangeActiveModelInput,
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
  ProviderSessionActiveModelChange,
} from '@/shared/types.js';
import {
  buildDefaultProviderCurrentActiveModel,
  getOpenCodeDatabasePath,
  readObjectRecord,
  readOptionalString,
  writeProviderSessionActiveModelChange,
} from '@/shared/utils.js';

export const OPENCODE_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    {
      value: 'anthropic/claude-sonnet-4-5',
      label: 'Claude Sonnet 4.5',
      description: 'anthropic - anthropic/claude-sonnet-4-5',
    },
    {
      value: 'anthropic/claude-opus-4-1',
      label: 'Claude Opus 4.1',
      description: 'anthropic - anthropic/claude-opus-4-1',
    },
    {
      value: 'anthropic/claude-haiku-4-5',
      label: 'Claude Haiku 4.5',
      description: 'anthropic - anthropic/claude-haiku-4-5',
    },
    {
      value: 'openai/gpt-5.1',
      label: 'GPT-5.1',
      description: 'openai - openai/gpt-5.1',
    },
    {
      value: 'openai/gpt-5.1-codex',
      label: 'GPT-5.1 Codex',
      description: 'openai - openai/gpt-5.1-codex',
    },
    {
      value: 'openai/gpt-5.4-mini',
      label: 'GPT-5.4 Mini',
      description: 'openai - openai/gpt-5.4-mini',
    },
  ],
  DEFAULT: 'anthropic/claude-sonnet-4-5',
  // Only ever returned when `opencode models` could not be read, so it is a
  // guess about a CLI whose own config decides the answer.
  PROVISIONAL: true,
};

const OPEN_CODE_MODELS_TIMEOUT_MS = 20_000;
// `<provider>/<model>`, where the model half may itself contain slashes: a
// custom openai-compatible provider addresses HuggingFace-style ids such as
// `dudin/cyankiwi/Qwen3.6-27B-AWQ-INT4`.
const MODEL_ID_LINE = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)+$/i;
// cross-spawn resolves .cmd shims/PATHEXT on Windows and delegates to
// child_process.spawn everywhere else.
const spawnFunction = crossSpawn;
const DATE_TOKEN = /^\d{8}$/;
const SIMPLE_NUMBER_TOKEN = /^\d$/;
const VERSION_TOKEN = /^[a-z]\d+$/i;
const NUMERIC_TOKEN = /^\d+(?:\.\d+)*$/;
const SHORT_ACRONYM_TOKEN = /^[a-z]{2,3}$/;

type OpenCodeVerboseModel = {
  id?: string;
  name?: string;
  providerID?: string;
  variants?: Record<string, unknown>;
};

export const parseOpenCodeModelsStdout = (stdout: string): string[] => {
  const ids: string[] = [];

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('{') || line.startsWith('[')) {
      continue;
    }

    if (MODEL_ID_LINE.test(line)) {
      ids.push(line);
    }
  }

  return [...new Set(ids)];
};

const countJsonBraceDelta = (value: string): number => {
  let delta = 0;
  let inString = false;
  let escaped = false;

  for (const character of value) {
    if (escaped) {
      escaped = false;
      continue;
    }

    if (character === '\\') {
      escaped = inString;
      continue;
    }

    if (character === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (character === '{') {
      delta += 1;
    } else if (character === '}') {
      delta -= 1;
    }
  }

  return delta;
};

const isOpenCodeVerboseModel = (value: unknown): value is OpenCodeVerboseModel => {
  const record = readObjectRecord(value);
  return Boolean(record && readOptionalString(record.id));
};

export const parseOpenCodeVerboseModelsStdout = (stdout: string): OpenCodeVerboseModel[] => {
  const models: OpenCodeVerboseModel[] = [];
  let buffer: string[] = [];
  let depth = 0;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (buffer.length === 0) {
      if (line === '{') {
        buffer = [rawLine];
        depth = 1;
      }
      continue;
    }

    buffer.push(rawLine);
    depth += countJsonBraceDelta(rawLine);

    if (depth !== 0) {
      continue;
    }

    try {
      const parsed = JSON.parse(buffer.join('\n'));
      if (isOpenCodeVerboseModel(parsed)) {
        models.push(parsed);
      }
    } catch {
      // Ignore malformed verbose blocks and fall back to the plain id parser.
    }

    buffer = [];
  }

  return models;
};

const formatDateToken = (token: string): string => (
  `${token.slice(0, 4)}-${token.slice(4, 6)}-${token.slice(6, 8)}`
);

const formatModelToken = (token: string, nextToken?: string): string => {
  const lower = token.toLowerCase();

  if (VERSION_TOKEN.test(token)) {
    return token.toUpperCase();
  }

  if (SHORT_ACRONYM_TOKEN.test(lower) && nextToken && NUMERIC_TOKEN.test(nextToken)) {
    return token.toUpperCase();
  }

  return lower.charAt(0).toUpperCase() + lower.slice(1);
};

const formatOpenCodeModelSlug = (slug: string): string => {
  const labelParts: string[] = [];
  const dateParts: string[] = [];
  const tokens = slug.split('-').filter(Boolean);

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const nextToken = tokens[index + 1];

    if (DATE_TOKEN.test(token)) {
      dateParts.push(formatDateToken(token));
      continue;
    }

    if (SIMPLE_NUMBER_TOKEN.test(token) && nextToken && SIMPLE_NUMBER_TOKEN.test(nextToken)) {
      labelParts.push(`${token}.${nextToken}`);
      index += 1;
      continue;
    }

    labelParts.push(formatModelToken(token, nextToken));
  }

  const label = (labelParts.join(' ').trim() || slug).replace(/^GPT\s+/, 'GPT-');
  if (dateParts.length === 0) {
    return label;
  }

  return `${label} (${dateParts.join(', ')})`;
};

const readOpenCodeModelParts = (id: string): { upstreamProvider: string; slug: string } => {
  const separatorIndex = id.indexOf('/');
  if (separatorIndex < 0) {
    return {
      upstreamProvider: '',
      slug: id,
    };
  }

  return {
    upstreamProvider: id.slice(0, separatorIndex),
    slug: id.slice(separatorIndex + 1),
  };
};

const isSupportedOpenCodeModelId = (id: string): boolean => (
  readOpenCodeModelParts(id).upstreamProvider.toLowerCase() !== 'google'
);

/**
 * Rebuilds the fully qualified `<providerID>/<id>` value `opencode run --model`
 * expects.
 *
 * The verbose block reports the *bare* model id, which for a custom
 * openai-compatible provider can itself contain a slash
 * (`{"id": "cyankiwi/Qwen3.6-27B-AWQ-INT4", "providerID": "dudin"}`). Treating
 * any slash as "already qualified" dropped the provider half and made every
 * such run exit 1, so qualification keys off the provider prefix instead.
 */
const readOpenCodeVerboseModelId = (model: OpenCodeVerboseModel): string | null => {
  const id = readOptionalString(model.id);
  if (!id) {
    return null;
  }

  const upstreamProvider = readOptionalString(model.providerID);
  if (!upstreamProvider || id === upstreamProvider || id.startsWith(`${upstreamProvider}/`)) {
    return id;
  }

  return `${upstreamProvider}/${id}`;
};

const labelForOpenCodeModelId = (id: string): string => {
  const fallbackLabel = OPENCODE_FALLBACK_MODELS.OPTIONS.find((option) => option.value === id)?.label;
  if (fallbackLabel) {
    return fallbackLabel;
  }

  const { slug } = readOpenCodeModelParts(id);
  return formatOpenCodeModelSlug(slug);
};

const descriptionForOpenCodeModelId = (id: string): string => {
  const { upstreamProvider } = readOpenCodeModelParts(id);
  return upstreamProvider ? `${upstreamProvider} - ${id}` : id;
};

const readOpenCodeVariantEffort = (key: string, value: unknown): string | null => {
  const variant = readObjectRecord(value);
  return readOptionalString(variant?.reasoningEffort)
    ?? readOptionalString(variant?.effort)
    ?? key;
};

const readOpenCodeEffortValues = (
  variants: OpenCodeVerboseModel['variants'],
): NonNullable<ProviderModelOption['effort']>['values'] => {
  const effortValues: NonNullable<ProviderModelOption['effort']>['values'] = [];
  const seenValues = new Set<string>();

  for (const [key, value] of Object.entries(variants ?? {})) {
    const effort = readOpenCodeVariantEffort(key, value);
    if (!effort || seenValues.has(effort)) {
      continue;
    }

    seenValues.add(effort);
    effortValues.push({ value: effort });
  }

  return effortValues;
};

const mapOpenCodeVerboseModel = (model: OpenCodeVerboseModel): ProviderModelOption | null => {
  const value = readOpenCodeVerboseModelId(model);
  if (!value || !isSupportedOpenCodeModelId(value)) {
    return null;
  }

  const effortValues = readOpenCodeEffortValues(model.variants);

  return {
    value,
    label: readOptionalString(model.name) ?? labelForOpenCodeModelId(value),
    description: descriptionForOpenCodeModelId(value),
    effort: effortValues.length > 0
      ? {
          values: effortValues,
        }
      : undefined,
  };
};

/**
 * Resolves the model the composer preselects.
 *
 * The user's own `model` from `opencode.json` wins, so pointing OpenCode at a
 * self-hosted provider is enough to make VibeSpace default to it too. Only when
 * that is absent (or names a model the CLI no longer lists) does the hosted
 * fallback, then the first listed model, apply.
 */
const pickOpenCodeDefault = (
  options: ProviderModelOption[],
  configuredModel?: string | null,
): string => (
  options.find((option) => option.value === configuredModel)?.value
    ?? options.find((option) => option.value === OPENCODE_FALLBACK_MODELS.DEFAULT)?.value
    ?? options[0]?.value
    ?? OPENCODE_FALLBACK_MODELS.DEFAULT
);

export const buildOpenCodeDefinitionFromIds = (
  ids: string[],
  configuredModel?: string | null,
): ProviderModelsDefinition => {
  const options: ProviderModelOption[] = ids
    .filter(isSupportedOpenCodeModelId)
    .map((value) => ({
      value,
      label: labelForOpenCodeModelId(value),
      description: descriptionForOpenCodeModelId(value),
    }));

  return {
    OPTIONS: options,
    DEFAULT: pickOpenCodeDefault(options, configuredModel),
  };
};

export const buildOpenCodeDefinitionFromVerboseModels = (
  models: OpenCodeVerboseModel[],
  configuredModel?: string | null,
): ProviderModelsDefinition => {
  const options: ProviderModelOption[] = [];
  const seenValues = new Set<string>();

  for (const model of models) {
    const mappedModel = mapOpenCodeVerboseModel(model);
    if (!mappedModel || seenValues.has(mappedModel.value)) {
      continue;
    }

    seenValues.add(mappedModel.value);
    options.push(mappedModel);
  }

  if (options.length === 0) {
    return OPENCODE_FALLBACK_MODELS;
  }

  return {
    OPTIONS: options,
    DEFAULT: pickOpenCodeDefault(options, configuredModel),
  };
};

const parseOpenCodeSessionModelValue = (rawModel: unknown): string | null => {
  if (typeof rawModel === 'string') {
    const trimmed = rawModel.trim();
    if (!trimmed) {
      return null;
    }

    try {
      return parseOpenCodeSessionModelValue(JSON.parse(trimmed));
    } catch {
      return trimmed;
    }
  }

  const record = readObjectRecord(rawModel);
  if (!record) {
    return null;
  }

  return readOptionalString(record.id)
    ?? readOptionalString(record.model)
    ?? readOptionalString(record.name)
    ?? readOptionalString(record.value)
    ?? null;
};

// Mirrors OpenCode's own global config lookup: an explicit OPENCODE_CONFIG file
// wins, otherwise every candidate under the config dir is loaded in order and
// the last one that declares a model wins.
const OPEN_CODE_CONFIG_FILES = ['config.json', 'opencode.json', 'opencode.jsonc'];

const readOpenCodeConfigDir = (): string => (
  process.env.OPENCODE_CONFIG_DIR?.trim()
    || path.join(process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config'), 'opencode')
);

export const listOpenCodeConfigPaths = (): string[] => {
  const explicitConfig = process.env.OPENCODE_CONFIG?.trim();
  if (explicitConfig) {
    return [explicitConfig];
  }

  const configDir = readOpenCodeConfigDir();
  return OPEN_CODE_CONFIG_FILES.map((fileName) => path.join(configDir, fileName));
};

/**
 * Removes `//` and block comments so `opencode.jsonc` parses with `JSON.parse`.
 * String literals are skipped so a URL inside a value survives intact.
 */
export const stripJsonComments = (source: string): string => {
  let output = '';
  let inString = false;
  let escaped = false;
  let index = 0;

  while (index < source.length) {
    const character = source[index];

    if (inString) {
      output += character;
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      index += 1;
      continue;
    }

    if (character === '"') {
      inString = true;
      output += character;
      index += 1;
      continue;
    }

    if (character === '/' && source[index + 1] === '/') {
      const lineEnd = source.indexOf('\n', index);
      index = lineEnd < 0 ? source.length : lineEnd;
      continue;
    }

    if (character === '/' && source[index + 1] === '*') {
      const blockEnd = source.indexOf('*/', index + 2);
      index = blockEnd < 0 ? source.length : blockEnd + 2;
      continue;
    }

    output += character;
    index += 1;
  }

  return output;
};

export const readOpenCodeConfiguredModel = (): string | null => {
  let configuredModel: string | null = null;

  for (const configPath of listOpenCodeConfigPaths()) {
    try {
      const parsed = JSON.parse(stripJsonComments(fsSync.readFileSync(configPath, 'utf8')));
      configuredModel = readOptionalString(readObjectRecord(parsed)?.model) ?? configuredModel;
    } catch {
      // A missing or malformed config simply leaves the previous value in place.
    }
  }

  return configuredModel;
};

const runOpenCodeModelsCommand = (): Promise<string> => new Promise((resolve, reject) => {
  const openCodeProcess = spawnFunction('opencode', ['models', '--verbose'], {
    cwd: process.cwd(),
    env: { ...process.env },
  });

  let stdout = '';
  let stderr = '';
  let settled = false;

  const timer = setTimeout(() => {
    openCodeProcess.kill('SIGTERM');
    if (!settled) {
      settled = true;
      reject(new Error('opencode models timed out'));
    }
  }, OPEN_CODE_MODELS_TIMEOUT_MS);

  const finish = (error: Error | null, output: string) => {
    if (settled) {
      return;
    }

    settled = true;
    clearTimeout(timer);

    if (error) {
      reject(error);
      return;
    }

    resolve(output);
  };

  openCodeProcess.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });

  openCodeProcess.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  openCodeProcess.on('error', (error) => {
    finish(error instanceof Error ? error : new Error(String(error)), '');
  });

  openCodeProcess.on('close', (code) => {
    if (code !== 0) {
      finish(new Error(stderr.trim() || `opencode models exited with code ${code}`), '');
      return;
    }

    finish(null, stdout);
  });
});

export class OpenCodeProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    try {
      const stdout = await runOpenCodeModelsCommand();
      const configuredModel = readOpenCodeConfiguredModel();
      const verboseModels = parseOpenCodeVerboseModelsStdout(stdout);
      if (verboseModels.length > 0) {
        return buildOpenCodeDefinitionFromVerboseModels(verboseModels, configuredModel);
      }

      const ids = parseOpenCodeModelsStdout(stdout);
      if (ids.length === 0) {
        // Falling back silently is how a broken `opencode models` turned into a
        // composer offering hosted Anthropic/OpenAI ids that a self-hosted
        // install cannot run — with nothing in the log to say why.
        console.warn('[OpenCode] `opencode models --verbose` listed no models; using the fallback catalog.');
        return OPENCODE_FALLBACK_MODELS;
      }

      return buildOpenCodeDefinitionFromIds(ids, configuredModel);
    } catch (error) {
      console.warn('[OpenCode] Unable to read the model catalog; using the fallback catalog:', error);
      return OPENCODE_FALLBACK_MODELS;
    }
  }

  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    if (!sessionId?.trim()) {
      return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
    }

    try {
      const dbPath = getOpenCodeDatabasePath();
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });

      try {
        const row = db.prepare(`
          SELECT
            s.id AS sessionId,
            s.model AS model,
            s.agent AS agent,
            s.directory AS directory,
            s.time_updated AS timeUpdated,
            s.time_created AS timeCreated
          FROM session s
          WHERE s.id = ?
          ORDER BY COALESCE(s.time_updated, s.time_created, 0) DESC
          LIMIT 1
        `).get(sessionId) as {
          sessionId?: string;
          model?: unknown;
          agent?: string | null;
          directory?: string | null;
          timeUpdated?: number | null;
          timeCreated?: number | null;
        } | undefined;

        const model = parseOpenCodeSessionModelValue(row?.model);
        if (model) {
          return {
            model,
          };
        }
      } finally {
        db.close();
      }
    } catch {
      // Fall through to the provider default when OpenCode session lookup fails.
    }

    return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }

  async changeActiveModel(
    input: ProviderChangeActiveModelInput,
  ): Promise<ProviderSessionActiveModelChange> {
    return writeProviderSessionActiveModelChange('opencode', input);
  }

  /**
   * Fingerprints the OpenCode config files the catalog is derived from.
   *
   * `opencode models --verbose` reports whatever `opencode.json` declares, so a
   * provider or model renamed there invalidates the cached catalog. Without
   * this the composer served a three-day-old list: after a self-hosted model id
   * changed, every send still went out with the retired id and the run came
   * back as an opaque provider error.
   */
  async getCatalogFingerprint(): Promise<string | null> {
    return listOpenCodeConfigPaths()
      .map((configPath) => {
        try {
          const stats = fsSync.statSync(configPath);
          return `${configPath}:${stats.mtimeMs}:${stats.size}`;
        } catch {
          return `${configPath}:absent`;
        }
      })
      .join('|');
  }
}
