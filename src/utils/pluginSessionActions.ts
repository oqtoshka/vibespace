import type { PluginSessionAction } from '../contexts/PluginsContext';

import { authenticatedFetch } from './api';

/**
 * Resolves a plugin session action to the URL it opens: the action's own
 * authenticated endpoint answers `{ url }` for this app session. Only http(s)
 * is accepted. Shared by the session menu and a launch option's chat banner,
 * so both open exactly the same place.
 */
export async function resolvePluginSessionActionUrl(action: PluginSessionAction, sessionId: string): Promise<string> {
  const endpoint = action.endpoint.replace('{sessionId}', encodeURIComponent(sessionId));
  const response = await authenticatedFetch(endpoint);
  const payload = await response.json();
  const rawUrl = payload?.url;
  if (!response.ok || typeof rawUrl !== 'string') {
    throw new Error('Session action is unavailable');
  }
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Session action returned an unsafe URL');
  }
  return url.toString();
}
