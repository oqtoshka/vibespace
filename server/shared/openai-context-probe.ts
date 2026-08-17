/**
 * Asks an OpenAI-compatible server how large a model's context window actually
 * is, instead of trusting a number somebody typed into a config file months ago.
 *
 * This exists because a self-hosted model's window is not a property of the
 * model, it is a property of today's deployment: vLLM's `--max-model-len` is
 * chosen against the VRAM that happens to be free, so the same weights serve
 * 64k one week and 136k the next. A hand-written `limit.context` is stale from
 * the moment the server restarts, and being wrong in either direction hurts —
 * too low silently throws away most of the window, too high turns a long
 * conversation into a hard request failure.
 */

/** Long enough for a LAN GPU box, short enough not to be felt in a turn. */
const PROBE_TIMEOUT_MS = 4_000;

export type ProbedContextWindow = {
  context: number;
  /** Which endpoint answered. Carried for logs; nothing branches on it. */
  via: string;
};

const asRecord = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
);

const readPositive = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
};

/** `sk-...` or OpenCode's own `{env:VAR}` indirection. */
export function resolveApiKey(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const fromEnv = value.match(/^\{env:([^}]+)\}$/);
  if (fromEnv) {
    const resolved = process.env[fromEnv[1]]?.trim();
    return resolved ? resolved : null;
  }
  return value.trim();
}

const trimSlashes = (url: string): string => url.replace(/\/+$/, '');

async function getJson(url: string, apiKey: string | null): Promise<unknown | null> {
  try {
    const response = await fetch(url, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : undefined,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    // Unreachable, unauthenticated, not JSON: all the same answer here — this
    // endpoint has nothing to say about the window.
    return null;
  }
}

/**
 * Pulls a window out of one model entry.
 *
 * `max_model_len` is vLLM's and is the authoritative one: it is the length the
 * running engine was actually built for. The other two are what proxies
 * republish. Deliberately absent is llama.cpp's `meta.n_ctx_train` — that is
 * the length the weights were trained at, not the length being served, and a
 * llama.cpp started with a smaller `-c` would report a window it will refuse.
 */
function readWindow(entry: Record<string, unknown>): number | null {
  return readPositive(entry.max_model_len)
    ?? readPositive(entry.max_input_tokens)
    ?? readPositive(entry.context_length);
}

async function readFromModelList(
  baseURL: string,
  modelKey: string,
  apiKey: string | null,
): Promise<ProbedContextWindow | null> {
  const url = `${trimSlashes(baseURL)}/models`;
  const data = asRecord(await getJson(url, apiKey))?.data;
  if (!Array.isArray(data)) return null;

  for (const raw of data) {
    const entry = asRecord(raw);
    if (!entry || entry.id !== modelKey) continue;
    const context = readWindow(entry);
    if (context) return { context, via: url };
    // The model is there but says nothing about its window — a proxy stripped
    // it. Keep going in case a second entry for the same id carries more.
  }

  return null;
}

/**
 * Follows a LiteLLM proxy back to the server actually holding the model.
 *
 * LiteLLM's `/v1/models` republishes `max_input_tokens` only for models in its
 * own cost catalog; a self-hosted one it routes to is listed with no limits at
 * all, so the honest number is one hop further down. `/model/info` names that
 * hop in `litellm_params.api_base`, which is what makes the real window
 * reachable rather than something the user has to copy by hand.
 *
 * Best-effort by design: on a proxy that authenticates this endpoint, or one
 * that is not LiteLLM, it returns null and the configured value stands.
 */
async function readViaLiteLLM(
  baseURL: string,
  modelKey: string,
  apiKey: string | null,
): Promise<ProbedContextWindow | null> {
  const url = `${trimSlashes(baseURL)}/model/info`;
  const data = asRecord(await getJson(url, apiKey))?.data;
  if (!Array.isArray(data)) return null;

  for (const raw of data) {
    const entry = asRecord(raw);
    if (!entry || entry.model_name !== modelKey) continue;

    const declared = readPositive(asRecord(entry.model_info)?.max_input_tokens);
    if (declared) return { context: declared, via: url };

    const upstream = asRecord(entry.litellm_params)?.api_base;
    if (typeof upstream !== 'string' || !upstream.trim()) continue;

    // `litellm_params.model` is provider-prefixed ("openai/local"); the
    // upstream server knows it by the bare name.
    const upstreamModel = typeof asRecord(entry.litellm_params)?.model === 'string'
      ? String(asRecord(entry.litellm_params)?.model).split('/').pop() ?? modelKey
      : modelKey;

    // One hop only. The upstream is the engine, not another router, and a
    // chain of proxies is not worth the latency of finding out.
    return await readFromModelList(upstream.trim(), upstreamModel, null)
      ?? await readFromModelList(upstream.trim(), modelKey, null);
  }

  return null;
}

/**
 * The window the serving stack reports for this model, or null when it will not
 * say. Never throws and never takes longer than two probe timeouts.
 */
export async function probeOpenAIContextWindow(input: {
  baseURL: string;
  modelKey: string;
  apiKey?: string | null;
}): Promise<ProbedContextWindow | null> {
  const baseURL = input.baseURL?.trim();
  if (!baseURL || !/^https?:\/\//i.test(baseURL) || !input.modelKey) return null;

  const apiKey = input.apiKey ?? null;
  return await readFromModelList(baseURL, input.modelKey, apiKey)
    ?? await readViaLiteLLM(baseURL, input.modelKey, apiKey);
}
