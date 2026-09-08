import { readFileSync, statSync } from 'node:fs';

type WorkerLink = {
  user_id: string;
  upstream: string;
  workerToken: string;
  workspace_dir: string;
  workspace_id: string;
  enabled: boolean;
};

/** Manager configuration consumes this read-only, reloadable deployment registry.
 * Read failures, invalid snapshots and expired controller leases deny all access.
 * The controller must atomically replace the file; workers never mount it.
 */
export class WorkerRegistry extends Map<string, WorkerLink> {
  private signature = '';
  private expiresAt = 0;
  constructor(private readonly filename: string) {
    super();
    this.refresh();
  }

  private refresh(): void {
    try {
      const stat = statSync(this.filename);
      const signature = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      if (signature === this.signature && Date.now() < this.expiresAt) return;
      const snapshot = JSON.parse(readFileSync(this.filename, 'utf8'));
      if (snapshot.version !== 1 || !Number.isFinite(snapshot.expiresAt)
          || snapshot.expiresAt <= Date.now() || !Array.isArray(snapshot.workers)) {
        throw new Error('Invalid or expired worker registry');
      }
      const next = new Map<string, WorkerLink>();
      for (const entry of snapshot.workers) {
        if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(entry.username)
            || typeof entry.workerToken !== 'string' || entry.workerToken.length < 32
            || typeof entry.workspaceDir !== 'string' || !entry.workspaceDir.startsWith('/')) {
          throw new Error('Invalid worker identity');
        }
        const upstream = new URL(entry.upstream);
        if (upstream.protocol !== 'http:' || upstream.username || upstream.password
            || upstream.pathname !== '/' || upstream.search || upstream.hash
            || next.has(entry.username)) throw new Error('Invalid worker endpoint');
        next.set(entry.username, {
          user_id: entry.username, upstream: entry.upstream,
          workerToken: entry.workerToken, workspace_dir: entry.workspaceDir, workspace_id: entry.workspaceId || entry.workspaceDir,
          enabled: entry.enabled !== false,
        });
      }
      super.clear();
      for (const [key, value] of next) super.set(key, value);
      this.signature = signature;
      this.expiresAt = snapshot.expiresAt;
    } catch {
      this.signature = '';
      this.expiresAt = 0;
      // Never retain a stale authorization snapshot after a controller failure.
      super.clear();
    }
  }

  override get(key: string): WorkerLink | undefined { this.refresh(); return super.get(key); }
  override has(key: string): boolean { this.refresh(); return super.has(key); }
  override keys(): MapIterator<string> { this.refresh(); return super.keys(); }
  override values(): MapIterator<WorkerLink> { this.refresh(); return super.values(); }
  override entries(): MapIterator<[string, WorkerLink]> { this.refresh(); return super.entries(); }
  override [Symbol.iterator](): MapIterator<[string, WorkerLink]> { return this.entries(); }
}
