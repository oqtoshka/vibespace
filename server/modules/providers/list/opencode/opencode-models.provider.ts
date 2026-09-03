import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import crossSpawn from 'cross-spawn';

import { sessionsDb } from '@/modules/database/index.js';
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
  isDatabaseLockedError,
  readObjectRecord,
  readOptionalString,
  stripAnsi,
  writeProviderSessionActiveModelChange,
} from '@/shared/utils.js';

/**
 * Curated OpenCode catalog shipped as immutable CloudCLI defaults.
 *
 * OpenCode routes by `<providerID>/<modelID>`, so this list mirrors the
 * providers `opencode models --verbose` reports: the OpenCode Zen gateway plus
 * the Anthropic and OpenAI providers OpenCode can address directly with the
 * user's own credentials.
 */
export const OPENCODE_PREDEFINED_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    { value: 'opencode/gpt-5.6-sol', label: 'GPT 5.6 Sol', description: 'OpenCode Zen' },
    { value: 'opencode/gpt-5.6-terra', label: 'GPT 5.6 Terra', description: 'OpenCode Zen' },
    { value: 'opencode/gpt-5.6-luna', label: 'GPT 5.6 Luna', description: 'OpenCode Zen' },
    { value: 'opencode/gpt-5.5', label: 'GPT 5.5', description: 'OpenCode Zen' },
    { value: 'opencode/gpt-5.5-pro', label: 'GPT 5.5 Pro', description: 'OpenCode Zen' },
    { value: 'opencode/gpt-5.4', label: 'GPT 5.4', description: 'OpenCode Zen' },
    { value: 'opencode/gpt-5.4-pro', label: 'GPT 5.4 Pro', description: 'OpenCode Zen' },
    { value: 'opencode/gpt-5.4-mini', label: 'GPT 5.4 Mini', description: 'OpenCode Zen' },
    { value: 'opencode/gpt-5.4-nano', label: 'GPT 5.4 Nano', description: 'OpenCode Zen' },
    { value: 'opencode/gpt-5.3-codex', label: 'GPT 5.3 Codex', description: 'OpenCode Zen' },
    { value: 'opencode/gpt-5.3-codex-spark', label: 'GPT 5.3 Codex Spark', description: 'OpenCode Zen' },
    { value: 'opencode/gpt-5.2', label: 'GPT 5.2', description: 'OpenCode Zen' },
    { value: 'opencode/gpt-5.1', label: 'GPT 5.1', description: 'OpenCode Zen' },
    { value: 'opencode/gpt-5', label: 'GPT 5', description: 'OpenCode Zen' },
    { value: 'opencode/gpt-5-nano', label: 'GPT 5 Nano', description: 'OpenCode Zen' },
    { value: 'opencode/claude-fable-5', label: 'Claude Fable 5', description: 'OpenCode Zen' },
    { value: 'opencode/claude-opus-5', label: 'Claude Opus 5', description: 'OpenCode Zen' },
    { value: 'opencode/claude-opus-4-8', label: 'Claude Opus 4.8', description: 'OpenCode Zen' },
    { value: 'opencode/claude-opus-4-7', label: 'Claude Opus 4.7', description: 'OpenCode Zen' },
    { value: 'opencode/claude-opus-4-6', label: 'Claude Opus 4.6', description: 'OpenCode Zen' },
    { value: 'opencode/claude-opus-4-5', label: 'Claude Opus 4.5', description: 'OpenCode Zen' },
    { value: 'opencode/claude-sonnet-5', label: 'Claude Sonnet 5', description: 'OpenCode Zen' },
    { value: 'opencode/claude-sonnet-4-6', label: 'Claude Sonnet 4.6', description: 'OpenCode Zen' },
    { value: 'opencode/claude-sonnet-4-5', label: 'Claude Sonnet 4.5', description: 'OpenCode Zen' },
    { value: 'opencode/claude-haiku-4-5', label: 'Claude Haiku 4.5', description: 'OpenCode Zen' },
    { value: 'opencode/gemini-3.6-flash', label: 'Gemini 3.6 Flash', description: 'OpenCode Zen' },
    { value: 'opencode/gemini-3.5-flash', label: 'Gemini 3.5 Flash', description: 'OpenCode Zen' },
    { value: 'opencode/gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite', description: 'OpenCode Zen' },
    { value: 'opencode/gemini-3.1-pro', label: 'Gemini 3.1 Pro', description: 'OpenCode Zen' },
    { value: 'opencode/gemini-3-flash', label: 'Gemini 3 Flash', description: 'OpenCode Zen' },
    { value: 'opencode/grok-4.5', label: 'Grok 4.5', description: 'OpenCode Zen' },
    { value: 'opencode/grok-build-0.1', label: 'Grok Build 0.1', description: 'OpenCode Zen' },
    { value: 'opencode/qwen3.7-max', label: 'Qwen3.7 Max', description: 'OpenCode Zen' },
    { value: 'opencode/qwen3.7-plus', label: 'Qwen3.7 Plus', description: 'OpenCode Zen' },
    { value: 'opencode/qwen3.6-plus', label: 'Qwen3.6 Plus', description: 'OpenCode Zen' },
    { value: 'opencode/qwen3.5-plus', label: 'Qwen3.5 Plus', description: 'OpenCode Zen' },
    { value: 'opencode/deepseek-v4-pro', label: 'DeepSeek V4 Pro', description: 'OpenCode Zen' },
    { value: 'opencode/deepseek-v4-flash', label: 'DeepSeek V4 Flash', description: 'OpenCode Zen' },
    { value: 'opencode/minimax-m3', label: 'MiniMax M3', description: 'OpenCode Zen' },
    { value: 'opencode/minimax-m2.7', label: 'MiniMax M2.7', description: 'OpenCode Zen' },
    { value: 'opencode/minimax-m2.5', label: 'MiniMax M2.5', description: 'OpenCode Zen' },
    { value: 'opencode/glm-5.2', label: 'GLM 5.2', description: 'OpenCode Zen' },
    { value: 'opencode/glm-5.1', label: 'GLM 5.1', description: 'OpenCode Zen' },
    { value: 'opencode/kimi-k2.5', label: 'Kimi K2.5', description: 'OpenCode Zen' },
    { value: 'opencode/kimi-k2.6', label: 'Kimi K2.6', description: 'OpenCode Zen' },
    { value: 'opencode/kimi-k2.7-code', label: 'Kimi K2.7 Code', description: 'OpenCode Zen' },
    { value: 'opencode/kimi-k3', label: 'Kimi K3', description: 'OpenCode Zen' },
    { value: 'opencode/big-pickle', label: 'Big Pickle', description: 'OpenCode Zen · Free' },
    { value: 'opencode/mimo-v2.5-free', label: 'MiMo-V2.5 Free', description: 'OpenCode Zen · Free' },
    { value: 'opencode/laguna-s-2.1-free', label: 'Laguna S 2.1 Free', description: 'OpenCode Zen · Free' },
    { value: 'opencode/ling-3.0-flash-free', label: 'Ling-3.0-flash Free', description: 'OpenCode Zen · Free' },
    { value: 'opencode/north-mini-code-free', label: 'North Mini Code Free', description: 'OpenCode Zen · Free' },
    { value: 'opencode/nemotron-3-ultra-free', label: 'Nemotron 3 Ultra Free', description: 'OpenCode Zen · Free' },
    { value: 'opencode/deepseek-v4-flash-free', label: 'DeepSeek V4 Flash Free', description: 'OpenCode Zen · Free' },
    { value: 'anthropic/claude-opus-5', label: 'Claude Opus 5', description: 'Anthropic' },
    { value: 'anthropic/claude-opus-5-fast', label: 'Claude Opus 5 Fast', description: 'Anthropic' },
    { value: 'anthropic/claude-fable-5', label: 'Claude Fable 5', description: 'Anthropic' },
    { value: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5', description: 'Anthropic' },
    { value: 'anthropic/claude-opus-4-8', label: 'Claude Opus 4.8', description: 'Anthropic' },
    { value: 'anthropic/claude-opus-4-8-fast', label: 'Claude Opus 4.8 Fast', description: 'Anthropic' },
    { value: 'anthropic/claude-opus-4-7', label: 'Claude Opus 4.7', description: 'Anthropic' },
    { value: 'anthropic/claude-opus-4-7-fast', label: 'Claude Opus 4.7 Fast', description: 'Anthropic' },
    { value: 'anthropic/claude-opus-4-6', label: 'Claude Opus 4.6', description: 'Anthropic' },
    { value: 'anthropic/claude-opus-4-6-fast', label: 'Claude Opus 4.6 Fast', description: 'Anthropic' },
    { value: 'anthropic/claude-opus-4-5', label: 'Claude Opus 4.5 (latest)', description: 'Anthropic' },
    { value: 'anthropic/claude-opus-4-5-20251101', label: 'Claude Opus 4.5', description: 'Anthropic' },
    { value: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6', description: 'Anthropic' },
    { value: 'anthropic/claude-sonnet-4-5', label: 'Claude Sonnet 4.5 (latest)', description: 'Anthropic' },
    { value: 'anthropic/claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5', description: 'Anthropic' },
    { value: 'anthropic/claude-haiku-4-5', label: 'Claude Haiku 4.5 (latest)', description: 'Anthropic' },
    { value: 'anthropic/claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', description: 'Anthropic' },
    { value: 'openai/gpt-5.6', label: 'GPT-5.6', description: 'OpenAI' },
    { value: 'openai/gpt-5.6-fast', label: 'GPT-5.6 Fast', description: 'OpenAI' },
    { value: 'openai/gpt-5.6-pro', label: 'GPT-5.6 Pro', description: 'OpenAI' },
    { value: 'openai/gpt-5.6-sol', label: 'GPT-5.6 Sol', description: 'OpenAI' },
    { value: 'openai/gpt-5.6-sol-fast', label: 'GPT-5.6 Sol Fast', description: 'OpenAI' },
    { value: 'openai/gpt-5.6-sol-pro', label: 'GPT-5.6 Sol Pro', description: 'OpenAI' },
    { value: 'openai/gpt-5.6-terra', label: 'GPT-5.6 Terra', description: 'OpenAI' },
    { value: 'openai/gpt-5.6-terra-fast', label: 'GPT-5.6 Terra Fast', description: 'OpenAI' },
    { value: 'openai/gpt-5.6-terra-pro', label: 'GPT-5.6 Terra Pro', description: 'OpenAI' },
    { value: 'openai/gpt-5.6-luna', label: 'GPT-5.6 Luna', description: 'OpenAI' },
    { value: 'openai/gpt-5.6-luna-fast', label: 'GPT-5.6 Luna Fast', description: 'OpenAI' },
    { value: 'openai/gpt-5.6-luna-pro', label: 'GPT-5.6 Luna Pro', description: 'OpenAI' },
    { value: 'openai/gpt-5.5', label: 'GPT-5.5', description: 'OpenAI' },
    { value: 'openai/gpt-5.5-fast', label: 'GPT-5.5 Fast', description: 'OpenAI' },
    { value: 'openai/gpt-5.4', label: 'GPT-5.4', description: 'OpenAI' },
    { value: 'openai/gpt-5.4-fast', label: 'GPT-5.4 Fast', description: 'OpenAI' },
    { value: 'openai/gpt-5.4-mini', label: 'GPT-5.4 mini', description: 'OpenAI' },
    { value: 'openai/gpt-5.4-mini-fast', label: 'GPT-5.4 mini Fast', description: 'OpenAI' },
    { value: 'openai/gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark', description: 'OpenAI' },
  ],
  DEFAULT: 'opencode/gpt-5.6-terra',
  // Only ever returned when `opencode models` could not be read, so it is a
  // guess about a CLI whose own config decides the answer.
  PROVISIONAL: true,
};

/** @deprecated Pre-1.37 name; the static catalog is now OPENCODE_PREDEFINED_MODELS. */
export const OPENCODE_FALLBACK_MODELS = OPENCODE_PREDEFINED_MODELS;

const OPEN_CODE_MODELS_TIMEOUT_MS = 20_000;
// Three attempts, ~1.5 s of waiting in total. opencode holds the lock for
// longer than its own 5 s busy_timeout only while it prunes or checkpoints the
// WAL, and that window is short; anything longer than this and the composer is
// better served by a provisional catalog it re-checks in a minute.
const OPEN_CODE_MODELS_LOCK_RETRIES = 3;
const OPEN_CODE_MODELS_LOCK_RETRY_DELAY_MS = 500;
// `<provider>/<model>`, where the model half may itself contain slashes: a
// custom openai-compatible provider addresses HuggingFace-style ids such as
// `homelab/cyankiwi/Qwen3.6-27B-AWQ-INT4`.
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
 * Both the catalog listing and the session row report the *bare* model id
 * beside its provider, and for a custom openai-compatible provider that id can
 * itself contain a slash (`{"id": "cyankiwi/Qwen3.6-27B-AWQ-INT4",
 * "providerID": "homelab"}`). Treating any slash as "already qualified" dropped
 * the provider half and made every such run exit 1, so qualification keys off
 * the provider prefix instead.
 */
const qualifyOpenCodeModelId = (id: string, upstreamProvider: string | null): string => {
  if (!upstreamProvider || id === upstreamProvider || id.startsWith(`${upstreamProvider}/`)) {
    return id;
  }

  return `${upstreamProvider}/${id}`;
};

const readOpenCodeVerboseModelId = (model: OpenCodeVerboseModel): string | null => {
  const id = readOptionalString(model.id);
  if (!id) {
    return null;
  }

  return qualifyOpenCodeModelId(id, readOptionalString(model.providerID) ?? null);
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

  const id = readOptionalString(record.id)
    ?? readOptionalString(record.model)
    ?? readOptionalString(record.name)
    ?? readOptionalString(record.value);
  if (!id) {
    return null;
  }

  // Sessions store the model split in two — `{"id": "zhiqing/Qwen3.6-27B",
  // "providerID": "homelab"}` — and the id half alone is not something
  // `opencode run --model` accepts, nor does it match any catalog entry, so
  // the picker could never highlight what the session was actually running.
  return qualifyOpenCodeModelId(id, readOptionalString(record.providerID) ?? null);
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
      finish(new Error(stripAnsi(stderr).trim() || `opencode models exited with code ${code}`), '');
      return;
    }

    finish(null, stdout);
  });
});

const sleep = (milliseconds: number): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});

/**
 * Runs the catalog probe, retrying only when opencode.db was locked.
 *
 * The probe reads the same database an `opencode run` writes to, so a busy
 * agent turn makes it fail for a reason that has nothing to do with the
 * catalog. Falling back then is actively harmful: the fallback lists hosted
 * Anthropic/OpenAI ids a self-hosted install cannot run, and the composer shows
 * them for the next minute. Every other failure still fails on the first
 * attempt — retrying a missing binary or a bad config just delays the answer.
 */
const runOpenCodeModelsCommandWithRetry = async (): Promise<string> => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await runOpenCodeModelsCommand();
    } catch (error) {
      if (attempt >= OPEN_CODE_MODELS_LOCK_RETRIES || !isDatabaseLockedError(error)) {
        throw error;
      }

      console.warn(
        `[OpenCode] opencode.db was locked while reading the model catalog; retrying (${attempt}/${OPEN_CODE_MODELS_LOCK_RETRIES - 1}).`,
      );
      await sleep(OPEN_CODE_MODELS_LOCK_RETRY_DELAY_MS * attempt);
    }
  }
};

/** Test seam. */
export const __testing = { parseOpenCodeSessionModelValue };

export class OpenCodeProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    try {
      const stdout = await runOpenCodeModelsCommandWithRetry();
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
      if (isDatabaseLockedError(error)) {
        console.warn(
          '[OpenCode] opencode.db stayed locked across every attempt; using the fallback catalog for the next minute.',
        );
      } else {
        console.warn('[OpenCode] Unable to read the model catalog; using the fallback catalog:', error);
      }

      return OPENCODE_FALLBACK_MODELS;
    }
  }

  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    if (!sessionId?.trim()) {
      return buildDefaultProviderCurrentActiveModel(OPENCODE_PREDEFINED_MODELS);
    }

    // OpenCode's `session` table is keyed by its own session id, so the stable
    // app id has to be translated first; sessions discovered on disk store the
    // provider id in both columns and resolve to themselves.
    const providerSessionId = sessionsDb.getSessionById(sessionId)?.provider_session_id ?? sessionId;

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
        `).get(providerSessionId) as {
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
      // Fall through to the curated default when OpenCode session lookup fails.
    }

    return buildDefaultProviderCurrentActiveModel(OPENCODE_PREDEFINED_MODELS);
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
  async changeActiveModel(
    input: ProviderChangeActiveModelInput,
  ): Promise<ProviderSessionActiveModelChange> {
    return writeProviderSessionActiveModelChange('opencode', input);
  }

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
