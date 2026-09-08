import type { LLMProvider } from '../types/app';

const known: LLMProvider[] = ['claude', 'cursor', 'codex', 'opencode'];
const configured = globalThis.window?.__VIBESPACE_CONFIG__?.enabledProviders?.join(',') ?? import.meta.env.VITE_ENABLED_PROVIDERS as string | undefined;
/** Build-time presentation policy; the backend independently enforces the allow-list. */
export const ENABLED_PROVIDERS: LLMProvider[] = configured === undefined
  ? known
  : known.filter((provider) => configured.split(',').map((value) => value.trim()).includes(provider));
if (!ENABLED_PROVIDERS.length) throw new Error('No enabled VibeSpace providers');
export const DEFAULT_PROVIDER = ENABLED_PROVIDERS[0];
export const isProviderEnabled = (provider: string): boolean => ENABLED_PROVIDERS.includes(provider as LLMProvider);

export const OPENCODE_DEFAULT_MODEL = globalThis.window?.__VIBESPACE_CONFIG__?.opencodeDefaultModel;
export const OPENCODE_LABEL = globalThis.window?.__VIBESPACE_CONFIG__?.opencodeLabel || 'OpenCode';
export const OPENCODE_AVATAR = globalThis.window?.__VIBESPACE_CONFIG__?.opencodeAvatar || '';
export const WORKSPACE_SERVICES = globalThis.window?.__VIBESPACE_CONFIG__?.workspaceServices === true;

declare global {
  interface Window {
    __VIBESPACE_CONFIG__?: { title?: string; enabledProviders?: string[]; opencodeLabel?: string; opencodeDefaultModel?: string; opencodeAvatar?: string; workspaceServices?: boolean };
  }
}
