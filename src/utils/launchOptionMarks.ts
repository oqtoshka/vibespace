import type { Plugin, PluginSessionAction } from '../contexts/PluginsContext';
import type { LaunchOptionDeclaration } from '../types/app';

/**
 * The declared launch options a session was started with that ask to be seen:
 * with a `marker` for the session list, with a `banner` for the chat. A
 * session's stored value is `true` or a small object; anything falsy is off.
 * A private session skips options declared `inertWhenPrivate`.
 */
export function sessionLaunchOptionsWith(
  declarations: LaunchOptionDeclaration[],
  sessionLaunchOptions: Record<string, unknown> | null | undefined,
  field: 'marker' | 'banner',
  isPrivate = false,
): LaunchOptionDeclaration[] {
  if (!sessionLaunchOptions) return [];
  return declarations.filter((option) => option[field]
    && Boolean(sessionLaunchOptions[option.id])
    && !(isPrivate && option.inertWhenPrivate));
}

/**
 * The session action a launch option's banner links to: `banner.actionId` in
 * the manifest of the enabled plugin that declared the option, or null.
 */
export function findLaunchOptionBannerAction(
  plugins: Plugin[],
  option: LaunchOptionDeclaration,
): PluginSessionAction | null {
  const actionId = option.banner?.actionId;
  if (!actionId || !option.pluginName) return null;
  const plugin = plugins.find((candidate) => candidate.name === option.pluginName && candidate.enabled);
  return plugin?.sessionActions?.find((action) => action.id === actionId) ?? null;
}

/**
 * The declared launch options an existing session may switch on or off: those
 * the plugin marks `switchable`, that apply to the session's provider, where
 * the provider supports the switch at all. None on a private session — the
 * server refuses there, and an `inertWhenPrivate` option would do nothing.
 * Consumer: ChatInterface (the chat ↔ briefing control).
 */
export function switchableLaunchOptions(
  declarations: LaunchOptionDeclaration[],
  provider: string,
  { providerSupportsSwitch, isPrivate }: { providerSupportsSwitch: boolean; isPrivate: boolean },
): LaunchOptionDeclaration[] {
  if (!providerSupportsSwitch || isPrivate) return [];
  return declarations.filter((option) => option.switchable === true
    && (!option.providers?.length || option.providers.includes(provider)));
}
