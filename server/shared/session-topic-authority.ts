import type { SessionTopicAuthorityContext, SessionTopicAuthoritySource } from './types.js';

const sources = new Set<SessionTopicAuthoritySource>();
const READ_TIMEOUT_MS = 5000;

/** Plugin host registers a current external-card authority reader, with teardown. */
export function registerSessionTopicAuthoritySource(source: SessionTopicAuthoritySource): () => void {
  sources.add(source);
  return () => { sources.delete(source); };
}

/** Recap generation checks actual authority before prompting and before committing.
 * Reads are best effort and bounded; absence never drops the persisted topic list. */
export async function readSessionTopicAuthority(context: SessionTopicAuthorityContext): Promise<'primary-agent' | null> {
  if (context.private || context.sessionRole !== 'main') return null;
  for (const source of sources) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const answer = await Promise.race([
        Promise.resolve().then(() => source(context)),
        new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), READ_TIMEOUT_MS); }),
      ]);
      if (answer === 'primary-agent') return answer;
    } catch {
      // An unavailable integration is not an empty authoritative topic list.
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return null;
}
