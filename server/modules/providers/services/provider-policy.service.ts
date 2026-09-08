import type { LLMProvider } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

const known: LLMProvider[] = ['claude', 'codex', 'cursor', 'opencode'];

/** Providers registry and websocket launchers use the operator-owned harness
 * allow-list. Unset preserves local installs; invalid/empty explicit lists fail closed.
 */
export const providerPolicy = {
  enabled(): LLMProvider[] {
    const raw = process.env.VS_ENABLED_PROVIDERS;
    if (raw === undefined) return [...known];
    const selected = raw.split(',').map((value) => value.trim());
    if (!selected.length || selected.some((value) => !known.includes(value as LLMProvider))) {
      throw new AppError('Invalid VS_ENABLED_PROVIDERS configuration.', { code: 'INVALID_PROVIDER_POLICY', statusCode: 503 });
    }
    return [...new Set(selected)] as LLMProvider[];
  },
  assertEnabled(provider: string): void {
    if (!this.enabled().includes(provider as LLMProvider)) {
      throw new AppError(`Provider "${provider}" is disabled by this deployment.`, { code: 'PROVIDER_DISABLED', statusCode: 403 });
    }
  },
};
