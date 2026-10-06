// eslint-disable-next-line boundaries/no-unknown -- Transitional facade reads existing cached legacy transports; migration does not move the transport implementation.
import { getExistingCodexAppServerTransports } from '../../../../services/codex-app-server.service.js';
/**
 * Codex runtime adapter — the registry-facing surface over `server/openai-codex.js`
 * (the app-server transport with turn steering, usage-limit wake and task
 * continuation). See the Claude adapter for the `run` id conventions.
 */
import {
  queryCodex as queryCodexImpl,
  injectCodexMessage as injectCodexMessageImpl,
  abortCodexSession as abortCodexSessionImpl,
  isCodexSessionActive as isCodexSessionActiveImpl,
  getActiveCodexSessions as getActiveCodexSessionsImpl,
  isCodexUsageLimitError as isCodexUsageLimitErrorImpl,
  pickCodexLimitReset as pickCodexLimitResetImpl,
  __resetCodexRateLimits as resetCodexRateLimitsImpl,
} from '../../../../openai-codex.js'; // eslint-disable-line boundaries/no-unknown -- Preserve the existing legacy runtime and registry cycle behind this typed facade.
import type { IProviderRuntime } from '../../../../shared/interfaces.js';

/*
 * Declared as a function, not a `const`, on purpose. The registry constructs
 * every provider at module load, and this module sits on an import cycle with
 * it (registry -> codex.provider -> here -> the impl -> services -> registry).
 * Whichever side is entered first, the other reads this binding while this
 * module is still mid-evaluation: a `const` would be in its TDZ and throw,
 * while a function declaration is initialized before evaluation starts. The
 * members are attached below and only ever read at call time.
 */
/** Provider registry uses this hoisted adapter to preserve its import cycle. */
export function codexRuntime(): never {
  throw new Error('codexRuntime is a runtime adapter object, not a function.');
}
codexRuntime.run = (...args: Parameters<IProviderRuntime['run']>) => queryCodexImpl(...args);
codexRuntime.abort = (sessionId: string) => abortCodexSessionImpl(sessionId);

/** Preserves the existing Codex runtime facade export for legacy consumers. */
export const queryCodex = queryCodexImpl;
/** Preserves the existing Codex runtime facade export for legacy consumers. */
export const injectCodexMessage = injectCodexMessageImpl;
/** Preserves the existing Codex runtime facade export for legacy consumers. */
export const abortCodexSession = abortCodexSessionImpl;
/** Preserves the existing Codex runtime facade export for legacy consumers. */
export const isCodexSessionActive = isCodexSessionActiveImpl;
/** Preserves the existing Codex runtime facade export for legacy consumers. */
export const getActiveCodexSessions = getActiveCodexSessionsImpl;
/** Preserves the existing Codex runtime facade export for legacy consumers. */
export const isCodexUsageLimitError = isCodexUsageLimitErrorImpl;
/** Preserves the existing Codex runtime facade export for legacy consumers. */
export const pickCodexLimitReset = pickCodexLimitResetImpl;
/** Preserves the existing Codex runtime facade export for legacy consumers. */
export const __resetCodexRateLimits = resetCodexRateLimitsImpl;

/** Providers admission observer reads cached transports through this legacy runtime facade. */
export function existingCodexTransports() {
  return getExistingCodexAppServerTransports();
}
