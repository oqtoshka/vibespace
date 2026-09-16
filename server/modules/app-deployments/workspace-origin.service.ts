/** Manager uses this for all browser writes and WebSocket upgrades when hosting apps.
 * Sibling app origins are same-site for cookies, so SameSite cookies alone do not
 * isolate them from the workspace. Native token clients without Origin remain valid.
 */
export function isWorkspaceOriginAllowed(origin: unknown, fetchSite: unknown, expected: string): boolean {
  if (typeof origin === 'string' && origin !== expected) return false;
  if (origin !== undefined && typeof origin !== 'string') return false;
  return fetchSite !== 'cross-site';
}
