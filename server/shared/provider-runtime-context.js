/**
 * Provider runtime context — one shape for two calling conventions.
 *
 * The chat gateway runs a provider through `providerRuntimeService.run(...)`,
 * which hands the runtime a `ProviderRuntimeContext` (session-id mapping,
 * model resolution, event normalization, install probe) and addresses the
 * conversation by its stable APP session id. Direct callers — the agent REST
 * routes, the git helper, server-initiated turns, tests — call the runtime
 * with the provider-native id and no context at all.
 *
 * `createProviderRuntimeContext` fills every missing lookup with the same
 * registry-backed service the gateway would have supplied, and
 * `normalizeRuntimeOptions` turns whichever id the caller used into the pair
 * the runtimes work with: `sessionId` = provider-native (what transcripts,
 * ledgers and the restore registry are keyed by), `appSessionId` = the
 * gateway's id (what abort/attach from the client arrive with).
 */
import { providerAuthService } from '../modules/providers/services/provider-auth.service.js';
import { providerModelsService } from '../modules/providers/services/provider-models.service.js';
import { sessionsService } from '../modules/providers/services/sessions.service.js';

/**
 * @param {string} provider
 * @param {object} [context] - Partial ProviderRuntimeContext; any missing
 *   member falls back to the shared services.
 */
export function createProviderRuntimeContext(provider, context) {
  return {
    resolveProviderSessionId: (sessionId) => (
      typeof context?.resolveProviderSessionId === 'function'
        ? context.resolveProviderSessionId(sessionId)
        : (sessionId || null)
    ),
    resolveResumeModel: (sessionId, requestedModel, resumeOptions) => (
      typeof context?.resolveResumeModel === 'function'
        ? context.resolveResumeModel(sessionId, requestedModel, resumeOptions)
        : providerModelsService.resolveResumeModel(provider, sessionId, requestedModel, resumeOptions)
    ),
    getProviderModels: async () => (
      typeof context?.getProviderModels === 'function'
        ? context.getProviderModels()
        : (await providerModelsService.getProviderModels(provider)).models
    ),
    normalizeMessage: (raw, sessionId) => (
      typeof context?.normalizeMessage === 'function'
        ? context.normalizeMessage(raw, sessionId)
        : sessionsService.normalizeMessage(provider, raw, sessionId)
    ),
    isProviderInstalled: () => (
      typeof context?.isProviderInstalled === 'function'
        ? context.isProviderInstalled()
        : providerAuthService.isProviderInstalled(provider)
    ),
  };
}

/**
 * Resolves the caller's `sessionId` into `{ sessionId: providerNativeId,
 * appSessionId }`. Idempotent: an already-normalized options object (a
 * continuation/fallback re-entry) passes through untouched.
 *
 * With a context, `options.sessionId` is the app id and the provider id comes
 * from the session row (or from `options.providerSessionId`, an
 * already-resolved hint). Without one, `options.sessionId` IS the provider id.
 */
export function normalizeRuntimeOptions(options, runtime, context) {
  if (!options || options.__normalized) {
    return options || {};
  }
  const requestedId = options.sessionId || null;
  let providerSessionId = options.providerSessionId || null;
  let appSessionId = options.appSessionId || null;
  if (!providerSessionId && requestedId) {
    providerSessionId = runtime.resolveProviderSessionId(requestedId) || null;
  }
  if (!appSessionId && requestedId && context) {
    // Either a distinct app id, or a row whose provider id equals its own id
    // (sessions discovered on disk store the provider id in both columns).
    appSessionId = requestedId;
  }
  return {
    ...options,
    __normalized: true,
    sessionId: providerSessionId || undefined,
    providerSessionId: providerSessionId || undefined,
    appSessionId: appSessionId || undefined,
    runtimeContext: context || options.runtimeContext,
  };
}
