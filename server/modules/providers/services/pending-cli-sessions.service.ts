import path from 'node:path';

/**
 * In-memory registry of app sessions whose Terminal tab just launched a
 * provider CLI that will allocate its own native session id.
 *
 * The chat flow records provider-native ids through the run registry, but a
 * session whose first conversation happens in the Terminal tab bypasses the
 * SDK entirely: the CLI invents an id the app never hears about, the
 * transcript watcher indexes it as a brand-new sidebar row, and the app
 * session the user is actually looking at stays empty forever. Shells
 * register here at spawn time; the synchronizer claims the newest matching
 * entry when it discovers a transcript whose id has no session row yet,
 * binding the CLI-native id to the app session before any duplicate row is
 * created.
 *
 * Entries are removed when claimed, when the owning PTY exits, or after a TTL
 * backstop (a terminal can sit idle a long while before the first prompt
 * creates the transcript, so the TTL is generous).
 */

type PendingCliSession = {
  provider: string;
  appSessionId: string;
  projectPath: string;
  registeredAt: number;
};

const PENDING_CLI_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The transcript watcher polls (~6s) and debounces (~2s), so a transcript the
 * CLI wrote moments before its PTY exited may not be indexed yet when release
 * fires. Releasing after a grace period keeps that claim winnable while still
 * preventing long-dead terminals from donating their app session.
 */
const RELEASE_GRACE_MS = 60 * 1000;

const pendingCliSessions: PendingCliSession[] = [];

/** Transcript cwd and shell project path may differ in trailing slashes etc. */
function normalizeForComparison(projectPath: string): string {
  return path.resolve(projectPath);
}

/**
 * Records that `appSessionId`'s terminal is about to start a fresh provider
 * CLI session in `projectPath`. Returns a release function the shell calls
 * when the PTY exits, so an abandoned terminal cannot donate its app session
 * to some unrelated CLI run started later.
 */
export function registerPendingCliSession(
  provider: string,
  appSessionId: string,
  projectPath: string
): () => void {
  const entry: PendingCliSession = {
    provider,
    appSessionId,
    projectPath: normalizeForComparison(projectPath),
    registeredAt: Date.now(),
  };
  pendingCliSessions.push(entry);

  return () => {
    const timer = setTimeout(() => {
      const index = pendingCliSessions.indexOf(entry);
      if (index !== -1) {
        pendingCliSessions.splice(index, 1);
      }
    }, RELEASE_GRACE_MS);
    // Never keep the process alive just to forget a pending registration.
    timer.unref?.();
  };
}

/**
 * Pops the newest live registration matching this provider + project.
 * Returns the app session id the discovered CLI session should attach to,
 * or null when no terminal is waiting for one.
 */
export function claimPendingCliSession(provider: string, projectPath: string): string | null {
  const now = Date.now();
  const normalizedProjectPath = normalizeForComparison(projectPath);

  for (let index = pendingCliSessions.length - 1; index >= 0; index -= 1) {
    const entry = pendingCliSessions[index];

    if (now - entry.registeredAt > PENDING_CLI_SESSION_TTL_MS) {
      pendingCliSessions.splice(index, 1);
      continue;
    }

    if (entry.provider === provider && entry.projectPath === normalizedProjectPath) {
      pendingCliSessions.splice(index, 1);
      return entry.appSessionId;
    }
  }

  return null;
}

/** Test seam. */
export function __clearPendingCliSessions(): void {
  pendingCliSessions.length = 0;
}
