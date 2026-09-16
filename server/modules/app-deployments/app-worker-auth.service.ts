import crypto from 'node:crypto';

/** Manager app endpoints accept an existing worker credential only within this
 * route scope. Identity comes from the live registry, never a supplied username.
 */
export function resolveAppWorker(token: string, links: {
  keys(): IterableIterator<string>;
  get(username: string): { enabled?: boolean; workerToken?: string; workspace_id?: string } | undefined;
}): string | null {
  if (token.length < 32 || token.length > 256) return null;
  const supplied = Buffer.from(token); const matches: string[] = [];
  for (const username of links.keys()) {
    const link = links.get(username);
    if (!link?.enabled || !link.workspace_id || !link.workerToken) continue;
    const expected = Buffer.from(link.workerToken);
    if (expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied)) matches.push(username);
  }
  return matches.length === 1 ? matches[0] : null;
}
