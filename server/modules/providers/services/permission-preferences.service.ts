import { appConfigDb, sessionsDb } from '@/modules/database/index.js';
import type { LLMProvider } from '@/shared/index.js';
import { providerCapabilitiesService } from './provider-capabilities.service.js';

function context(userId: number, provider: string, sessionId?: string) {
  if (!Number.isSafeInteger(userId) || userId < 1) throw new Error('Invalid user');
  const capabilities = providerCapabilitiesService.getProviderCapabilities(provider as LLMProvider);
  if (!capabilities) throw new Error('Invalid provider');
  if (sessionId && sessionsDb.getSessionById(sessionId)?.provider !== provider) throw new Error('Invalid session');
  return { capabilities, key: `permission-default:${userId}:${provider}` };
}

/** Settings and native chat share persisted operator preferences. Session choices
 * override provider defaults; a native request cannot supply its own runtime mode. */
export const permissionPreferencesService = {
  get(userId: number, provider: string, sessionId?: string) {
    const { capabilities, key } = context(userId, provider, sessionId);
    const valid = (mode: string | null) => mode && capabilities.permissionModes.includes(mode) ? mode : null;
    const defaultMode = valid(appConfigDb.get(key)) ?? capabilities.defaultPermissionMode;
    const sessionMode = sessionId ? valid(sessionsDb.getSessionPermissionMode(sessionId)) : null;
    return { defaultMode, sessionMode, permissionMode: sessionMode ?? defaultMode };
  },
  update(userId: number, provider: string, sessionId: string | undefined, input: Record<string, unknown>) {
    const { capabilities, key } = context(userId, provider, sessionId);
    for (const name of ['defaultMode', 'sessionMode']) {
      if (input[name] !== undefined && (typeof input[name] !== 'string' || !capabilities.permissionModes.includes(input[name] as string))) throw new Error('Invalid permission mode');
    }
    if (input.sessionMode !== undefined && !sessionId) throw new Error('Session required');
    // Migration is insert-only: an old browser cannot overwrite a newer server choice.
    const onlyMissing = input.onlyIfMissing === true;
    if (typeof input.defaultMode === 'string' && (!onlyMissing || appConfigDb.get(key) === null)) appConfigDb.set(key, input.defaultMode);
    if (sessionId && typeof input.sessionMode === 'string' && (!onlyMissing || sessionsDb.getSessionPermissionMode(sessionId) === null)) sessionsDb.setSessionPermissionMode(sessionId, input.sessionMode);
    return this.get(userId, provider, sessionId);
  },
};
