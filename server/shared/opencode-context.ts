import { execFile } from 'node:child_process';
import fsSync from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { createNormalizedMessage, getOpenCodeDatabasePath } from '@/shared/utils.js';
import { rememberContextUsage } from '@/shared/context-usage-cache.js';
import type { ContextUsage } from '@/shared/types.js';

/**
 * What OpenCode does about a conversation that outgrows its model's window.
 *
 * Mirrors the `compaction` block of `opencode.json`. Every field is optional
 * there; the values here are what OpenCode itself falls back to, so the UI can
 * show a real number instead of "default".
 */
export type OpenCodeCompactionConfig = {
  /** Compact automatically when the context fills. OpenCode defaults to true. */
  auto: boolean;
  /** Drop old tool output rather than summarising it. OpenCode defaults to false. */
  prune: boolean;
  /** Turns kept verbatim after a compaction. Null means "as many as the token budget allows". */
  tailTurns: number | null;
  /** Token budget for the verbatim tail. Null means OpenCode's own 25%-of-window rule. */
  preserveRecentTokens: number | null;
  /** Headroom left free for the reply. Null means "as much as the model can output". */
  reserved: number | null;
};

export type OpenCodeModelLimit = {
  context: number;
  /**
   * Some models declare a separate input ceiling. It matters far beyond its
   * apparent importance — see `resolveCompactionThreshold`.
   */
  input: number | null;
  output: number;
};

/** One turn's context occupancy, in the shape OpenCode reports it. */
export type OpenCodeStepTokens = {
  input?: number;
  output?: number;
  reasoning?: number;
  total?: number;
  cache?: { read?: number; write?: number };
};

const DEFAULT_COMPACTION: OpenCodeCompactionConfig = {
  auto: true,
  prune: false,
  tailTurns: null,
  preserveRecentTokens: null,
  reserved: null,
};

/** How long a spawned model catalog stays good enough for a gauge. */
const MODEL_LIMIT_TTL_MS = 10 * 60 * 1000;
const MODELS_COMMAND_TIMEOUT_MS = 20_000;

const readNumber = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const readPositiveOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const asRecord = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
);

/**
 * Where OpenCode keeps the config this app is allowed to edit.
 *
 * Only the global file. OpenCode also merges a per-project `opencode.json` and
 * anything `OPENCODE_CONFIG` points at, and those belong to whoever put them
 * in the repository — writing to them from a settings dialog would edit a
 * checked-in file behind the user's back.
 */
export function getOpenCodeConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), '.config');
  return path.join(base, 'opencode', 'opencode.json');
}

function readConfigFileSync(): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(fsSync.readFileSync(getOpenCodeConfigPath(), 'utf8')));
  } catch {
    // Missing or malformed: every caller wants OpenCode's defaults, not an error.
    return null;
  }
}

/**
 * The model OpenCode uses when a session does not name one.
 *
 * The settings screen opens without a conversation in hand, so this is what it
 * describes the window of.
 */
export function readOpenCodeDefaultModel(): string | null {
  const model = readConfigFileSync()?.model;
  return typeof model === 'string' && model.includes('/') ? model : null;
}

/**
 * Reads the compaction block, filling in OpenCode's own defaults.
 */
export function readOpenCodeCompactionConfig(): OpenCodeCompactionConfig {
  const compaction = asRecord(readConfigFileSync()?.compaction);
  if (!compaction) return { ...DEFAULT_COMPACTION };

  return {
    auto: compaction.auto === undefined ? DEFAULT_COMPACTION.auto : compaction.auto !== false,
    prune: compaction.prune === undefined ? DEFAULT_COMPACTION.prune : compaction.prune === true,
    tailTurns: readPositiveOrNull(compaction.tail_turns),
    preserveRecentTokens: readPositiveOrNull(compaction.preserve_recent_tokens),
    reserved: readPositiveOrNull(compaction.reserved),
  };
}

/**
 * Writes the compaction block back, leaving the rest of the file alone.
 *
 * A field set to null is removed, which is how the UI says "back to OpenCode's
 * default" — writing the default value instead would freeze it against future
 * OpenCode releases.
 */
export async function writeOpenCodeCompactionConfig(
  patch: Partial<OpenCodeCompactionConfig>,
): Promise<OpenCodeCompactionConfig> {
  const configPath = getOpenCodeConfigPath();
  const existing = readConfigFileSync() ?? {};
  const compaction = { ...(asRecord(existing.compaction) ?? {}) };

  const assign = (key: string, value: number | boolean | null | undefined) => {
    if (value === undefined) return;
    if (value === null) {
      delete compaction[key];
      return;
    }
    compaction[key] = value;
  };

  assign('auto', patch.auto);
  assign('prune', patch.prune);
  assign('tail_turns', patch.tailTurns);
  assign('preserve_recent_tokens', patch.preserveRecentTokens);
  assign('reserved', patch.reserved);

  const next = { ...existing };
  if (Object.keys(compaction).length > 0) {
    next.compaction = compaction;
  } else {
    delete next.compaction;
  }

  await fsp.mkdir(path.dirname(configPath), { recursive: true });
  // Written whole rather than patched in place: OpenCode re-reads this file on
  // its own schedule, and a half-written one is a hard startup failure.
  const temporaryPath = `${configPath}.vibespace-tmp`;
  await fsp.writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  await fsp.rename(temporaryPath, configPath);

  return readOpenCodeCompactionConfig();
}

/**
 * Sets (or clears) a model's declared input ceiling in the user's config.
 *
 * This exists for one reason: `compaction.reserved` is dead configuration
 * until the model declares `limit.input` — see `resolveCompactionThreshold`.
 * Without a way to declare one, "choose when it compacts" is not a setting a
 * user of a custom provider can actually have.
 *
 * Only models the user declares themselves can be edited. A model that comes
 * from OpenCode's own catalog has no entry here to amend, and inventing one
 * would override the real catalog with a partial copy of it.
 */
export async function writeOpenCodeModelInputLimit(
  modelId: string,
  inputTokens: number | null,
): Promise<OpenCodeModelLimit | null> {
  const separator = modelId.indexOf('/');
  if (separator <= 0) return null;

  const providerId = modelId.slice(0, separator);
  const modelKey = modelId.slice(separator + 1);
  const configPath = getOpenCodeConfigPath();
  const existing = readConfigFileSync() ?? {};

  const providers = asRecord(existing.provider);
  const provider = asRecord(providers?.[providerId]);
  const models = asRecord(provider?.models);
  const model = asRecord(models?.[modelKey]);
  if (!providers || !provider || !models || !model) return null;

  const limit = { ...(asRecord(model.limit) ?? {}) };
  if (inputTokens === null) {
    delete limit.input;
  } else {
    limit.input = inputTokens;
  }

  const next = {
    ...existing,
    provider: {
      ...providers,
      [providerId]: {
        ...provider,
        models: { ...models, [modelKey]: { ...model, limit } },
      },
    },
  };

  const temporaryPath = `${configPath}.vibespace-tmp`;
  await fsp.writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  await fsp.rename(temporaryPath, configPath);
  modelLimitCache = null;

  return readModelLimitFromConfig(modelId);
}

let modelLimitCache: { readAt: number; limits: Map<string, OpenCodeModelLimit> } | null = null;

function readModelLimitFromConfig(modelId: string): OpenCodeModelLimit | null {
  const separator = modelId.indexOf('/');
  if (separator <= 0) return null;

  const providerId = modelId.slice(0, separator);
  const modelKey = modelId.slice(separator + 1);
  const providers = asRecord(readConfigFileSync()?.provider);
  const models = asRecord(asRecord(providers?.[providerId])?.models);
  const limit = asRecord(asRecord(models?.[modelKey])?.limit);
  if (!limit) return null;

  const context = readNumber(limit.context);
  if (context <= 0) return null;

  return {
    context,
    input: readPositiveOrNull(limit.input),
    output: readNumber(limit.output),
  };
}

function runOpenCodeModels(): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      'opencode',
      ['models', '--verbose'],
      { timeout: MODELS_COMMAND_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => resolve(error && !stdout ? '' : String(stdout ?? '')),
    );
  });
}

/**
 * Parses `opencode models --verbose`, which prints an id line followed by the
 * model's JSON block.
 */
export function parseOpenCodeModelLimits(stdout: string): Map<string, OpenCodeModelLimit> {
  const limits = new Map<string, OpenCodeModelLimit>();
  const lines = stdout.split(/\r?\n/);
  let buffer: string[] = [];
  let depth = 0;

  for (const line of lines) {
    if (buffer.length === 0) {
      if (line.trim() === '{') {
        buffer = [line];
        depth = 1;
      }
      continue;
    }

    buffer.push(line);
    // The blocks are machine-printed one token per line, so counting braces on
    // non-string lines is enough; no JSON string can open one here.
    depth += (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0);
    if (depth !== 0) continue;

    try {
      const parsed = asRecord(JSON.parse(buffer.join('\n')));
      const id = typeof parsed?.id === 'string' ? parsed.id : null;
      const providerId = typeof parsed?.providerID === 'string' ? parsed.providerID : null;
      const limit = asRecord(parsed?.limit);
      const context = readNumber(limit?.context);
      if (id && providerId && context > 0) {
        limits.set(`${providerId}/${id}`, {
          context,
          input: readPositiveOrNull(limit?.input),
          output: readNumber(limit?.output),
        });
      }
    } catch {
      // A block that does not parse is one model missing from the gauge.
    }

    buffer = [];
  }

  return limits;
}

/**
 * The model's real window, or null when it cannot be established.
 *
 * The config is consulted first because a custom provider declares its limits
 * there and answering from it costs a file read. Everything else — the models
 * OpenCode knows from its own catalog — needs the CLI, which is slow enough to
 * be worth caching and never worth blocking a turn on.
 */
export async function resolveOpenCodeModelLimit(modelId: string | null | undefined): Promise<OpenCodeModelLimit | null> {
  if (!modelId) return null;

  const fromConfig = readModelLimitFromConfig(modelId);
  if (fromConfig) return fromConfig;

  const fresh = modelLimitCache && Date.now() - modelLimitCache.readAt < MODEL_LIMIT_TTL_MS;
  if (!fresh) {
    modelLimitCache = { readAt: Date.now(), limits: parseOpenCodeModelLimits(await runOpenCodeModels()) };
  }

  return modelLimitCache?.limits.get(modelId) ?? null;
}

/** Test seam. */
export function clearOpenCodeModelLimitCache(): void {
  modelLimitCache = null;
}

/**
 * The occupancy at which OpenCode compacts, in absolute tokens.
 *
 * This is OpenCode's own arithmetic (`SessionCompaction.isOverflow`), repeated
 * rather than approximated, because a gauge that disagrees with the runtime is
 * worse than no gauge. Note what it does with `reserved`: the setting is read
 * unconditionally but only *applied* when the model declares `limit.input`.
 * Without one the threshold is fixed at `context - output` and no amount of
 * configuration moves it — which is why the API reports whether the setting is
 * doing anything at all.
 */
export function resolveCompactionThreshold(
  limit: OpenCodeModelLimit,
  compaction: OpenCodeCompactionConfig,
): number {
  if (limit.context <= 0) return 0;

  const maxOutput = limit.output > 0 ? limit.output : 0;
  if (limit.input) {
    const reserved = compaction.reserved ?? maxOutput;
    return Math.max(0, limit.input - reserved);
  }

  return Math.max(0, limit.context - maxOutput);
}

/** True when `compaction.reserved` would change the threshold for this model. */
export function isReservedHonored(limit: OpenCodeModelLimit): boolean {
  return Boolean(limit.input);
}

/**
 * How much of the window one turn actually occupies.
 *
 * Not the session's running total. Every turn resends the conversation, so the
 * tokens billed over a session are unbounded while the context they occupy is
 * not: the session row in `opencode.db` had 200k against a 64k window, which is
 * a true statement about spend and a meaningless one about how full the window
 * is. OpenCode decides to compact on this number, so the gauge reads it too.
 */
export function readContextOccupancy(tokens: OpenCodeStepTokens | null | undefined): number {
  if (!tokens) return 0;

  const total = readNumber(tokens.total);
  if (total > 0) return total;

  return readNumber(tokens.input)
    + readNumber(tokens.output)
    + readNumber(tokens.cache?.read)
    + readNumber(tokens.cache?.write);
}

/**
 * Reads the newest assistant turn's token counts out of `opencode.db`.
 *
 * The turn that ran over the CLI transport is gone by the time anything here
 * can ask it, and the session row only carries running totals. The messages it
 * wrote carry the per-turn figures, and the last one is the current occupancy.
 */
export function readLatestOpenCodeTurnTokens(sessionId: string | null | undefined): OpenCodeStepTokens | null {
  const dbPath = getOpenCodeDatabasePath();
  if (!sessionId || !fsSync.existsSync(dbPath)) return null;

  let db: InstanceType<typeof Database> | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const rows = db.prepare(`
      SELECT data
      FROM message
      WHERE session_id = ?
      ORDER BY time_created DESC
      LIMIT 20
    `).all(sessionId) as Array<{ data: string }>;

    for (const row of rows) {
      try {
        const parsed = asRecord(JSON.parse(row.data));
        const tokens = asRecord(parsed?.tokens) as OpenCodeStepTokens | null;
        if (tokens && readContextOccupancy(tokens) > 0) return tokens;
      } catch {
        // Not every message row carries usage; keep walking back.
      }
    }

    return null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/**
 * Builds the gauge reading for one OpenCode turn.
 *
 * `autoCompactThreshold` is an absolute token count, matching what the Claude
 * runtime reports and what the client already knows how to read.
 */
export async function buildOpenCodeContextUsage(input: {
  modelId: string | null | undefined;
  tokens: OpenCodeStepTokens | null | undefined;
  sessionId?: string | null;
}): Promise<ContextUsage | null> {
  const limit = await resolveOpenCodeModelLimit(input.modelId);
  if (!limit || limit.context <= 0) return null;

  const tokens = input.tokens && readContextOccupancy(input.tokens) > 0
    ? input.tokens
    : readLatestOpenCodeTurnTokens(input.sessionId);
  const totalTokens = readContextOccupancy(tokens);
  if (totalTokens <= 0) return null;

  const compaction = readOpenCodeCompactionConfig();

  return {
    totalTokens,
    maxTokens: limit.context,
    percentage: Math.min(100, (totalTokens / limit.context) * 100),
    model: input.modelId ?? undefined,
    autoCompactThreshold: compaction.auto ? resolveCompactionThreshold(limit, compaction) : undefined,
    isAutoCompactEnabled: compaction.auto,
  };
}

export type OpenCodeCompactionSettings = {
  configPath: string;
  compaction: OpenCodeCompactionConfig;
  /** The model the numbers below describe, when one was asked about. */
  model: string | null;
  limit: OpenCodeModelLimit | null;
  /** Occupancy at which OpenCode compacts, in tokens. Null when the window is unknown. */
  compactAtTokens: number | null;
  /**
   * False when `reserved` is set but cannot take effect, because the model
   * declares no `limit.input`. OpenCode reads the setting and then ignores it,
   * so a settings dialog that stays quiet about this looks broken.
   */
  reservedHonored: boolean;
};

/**
 * Everything the settings screen needs to show what compaction will do.
 */
export async function describeOpenCodeCompaction(modelId: string | null): Promise<OpenCodeCompactionSettings> {
  const compaction = readOpenCodeCompactionConfig();
  const resolvedModel = modelId ?? readOpenCodeDefaultModel();
  const limit = await resolveOpenCodeModelLimit(resolvedModel);

  return {
    configPath: getOpenCodeConfigPath(),
    compaction,
    model: resolvedModel,
    limit,
    compactAtTokens: limit ? resolveCompactionThreshold(limit, compaction) : null,
    reservedHonored: limit ? isReservedHonored(limit) : true,
  };
}

/**
 * Publishes the gauge for a finished OpenCode turn, and remembers it so a page
 * reload or a session switch restores it instead of dropping to a bare count.
 *
 * Never throws: a missing gauge is a missing nicety, not a failed turn.
 */
export async function sendOpenCodeContextUsage(input: {
  ws: { send: (message: unknown) => void };
  sessionId: string | null;
  modelId: string | null | undefined;
  tokens?: OpenCodeStepTokens | null;
}): Promise<void> {
  try {
    const contextUsage = await buildOpenCodeContextUsage({
      modelId: input.modelId,
      tokens: input.tokens,
      sessionId: input.sessionId,
    });
    if (!contextUsage) return;

    rememberContextUsage(input.sessionId, contextUsage);
    input.ws.send(createNormalizedMessage({
      kind: 'status',
      text: 'context_usage',
      contextUsage,
      sessionId: input.sessionId,
      provider: 'opencode',
    }));
  } catch (error) {
    console.warn('[opencode context] usage probe failed:', (error as Error)?.message ?? error);
  }
}
