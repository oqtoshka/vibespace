import crypto from 'node:crypto';

import Database from 'better-sqlite3';

type Links = { get(username: string): { enabled?: boolean; workspace_id?: string } | undefined };
type App = {
  id: string; owner: string; workspace_id: string; name: string; source: string;
  runtime: string; entrypoint: string; hostname: string; access_version: number;
  desired: string; operation: string; status: string; generation: number; observed_generation: number;
  created_at: string; updated_at: string; error: string | null; logs: string; revision: string | null;
};
function fail(message: string, status = 400): never { throw Object.assign(new Error(message), { status }); }

function relativePath(value: string): string {
  if (!value || value.length > 512 || /[\x00-\x1f\\]/.test(value)
    || value.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.'))) {
    fail('Use a workspace-relative path without hidden directories or traversal.');
  }
  return value;
}

/** Manager app routes use this durable control plane; an external trusted runtime
 * reconciles desired generations. Workers never receive this database or signing key.
 */
export class AppControl {
  private readonly db: Database.Database;
  constructor(filename: string, private readonly links: Links, private readonly domain: string, private readonly signingKey: string) {
    if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(domain) || signingKey.length < 32) {
      throw new Error('App domain and a signing key of at least 32 characters are required.');
    }
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL'); this.db.pragma('busy_timeout = 5000');
    this.db.exec(`CREATE TABLE IF NOT EXISTS applications (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, workspace_id TEXT NOT NULL,
      name TEXT NOT NULL, source TEXT NOT NULL, runtime TEXT NOT NULL, entrypoint TEXT NOT NULL,
      hostname TEXT NOT NULL UNIQUE, access_version INTEGER NOT NULL DEFAULT 1,
      desired TEXT NOT NULL, operation TEXT NOT NULL DEFAULT 'deploy', status TEXT NOT NULL, generation INTEGER NOT NULL,
      observed_generation INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      error TEXT, logs TEXT NOT NULL DEFAULT '', revision TEXT,
      lease_until INTEGER NOT NULL DEFAULT 0, controller_id TEXT
    ); CREATE INDEX IF NOT EXISTS applications_owner ON applications(owner);`);
  }
  private identity(owner: string): string {
    const link = this.links.get(owner);
    if (!link?.enabled || !link.workspace_id) fail('Workspace access is unavailable.', 403);
    return link.workspace_id;
  }
  private owned(owner: string, id: string): App {
    const workspace = this.identity(owner);
    const app = this.db.prepare('SELECT * FROM applications WHERE id=? AND owner=? AND workspace_id=?').get(id, owner, workspace) as App | undefined;
    if (!app) fail('Application not found.', 404);
    return app;
  }
  list(owner: string) {
    const workspace = this.identity(owner);
    const rows = this.db.prepare('SELECT * FROM applications WHERE owner=? AND workspace_id=? ORDER BY created_at DESC').all(owner, workspace) as App[];
    return { enabled: true, apps: rows.map(({ logs: _logs, ...app }) => ({ ...app, url: `https://${app.hostname}` })), limits: { apps: 3, storageMiB: 256, memoryMiB: 256 } };
  }
  create(owner: string, input: { name: string; source: string; runtime: string; entrypoint: string }) {
    const workspace = this.identity(owner);
    const name = input.name.trim();
    if (!name || name.length > 80 || /[\x00-\x1f]/.test(name)) fail('Name must contain 1–80 printable characters.');
    const source = relativePath(input.source); const entrypoint = relativePath(input.entrypoint);
    if (!['node', 'python'].includes(input.runtime)) fail('Runtime must be node or python.');
    return this.db.transaction(() => {
      // Retained volumes count against capacity too; removal cannot bypass storage quotas.
      const count = this.db.prepare('SELECT count(*) AS n FROM applications WHERE owner=?').get(owner) as { n: number };
      const global = this.db.prepare('SELECT count(*) AS n FROM applications').get() as { n: number };
      if (count.n >= 3 || global.n >= 24) fail('Application capacity reached, including retained storage. Contact the administrator.', 409);
      const id = crypto.randomBytes(16).toString('hex');
      const hostname = `a-${crypto.randomBytes(24).toString('hex')}.${this.domain}`;
      const now = new Date().toISOString();
      this.db.prepare(`INSERT INTO applications(id,owner,workspace_id,name,source,runtime,entrypoint,hostname,desired,status,generation,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,'running','queued',1,?,?)`).run(id, owner, workspace, name, source, input.runtime, entrypoint, hostname, now, now);
      return this.owned(owner, id);
    })();
  }
  command(owner: string, id: string, action: string) {
    if (!['start', 'stop', 'redeploy', 'remove'].includes(action)) fail('Unknown application action.');
    return this.db.transaction(() => {
      const app = this.owned(owner, id);
      if (app.generation !== app.observed_generation) fail('An application operation is already pending.', 409);
      if (app.desired === 'removed') fail('Application removed; retained storage is available to the administrator.', 409);
      const desired = action === 'stop' ? 'stopped' : action === 'remove' ? 'removed' : 'running';
      if ((action === 'start' && app.status === 'running') || (action === 'stop' && app.status === 'stopped')) return app;
      this.db.prepare(`UPDATE applications SET desired=?,operation=?,status='queued',generation=generation+1,error=NULL,updated_at=?,
        access_version=access_version+? WHERE id=?`).run(desired, action, new Date().toISOString(), action === 'remove' ? 1 : 0, id);
      return this.owned(owner, id);
    })();
  }
  logs(owner: string, id: string) {
    const app = this.owned(owner, id); return { logs: app.logs.slice(-32_768), status: app.status, error: app.error };
  }
  grant(owner: string, id: string, share: boolean) {
    const app = this.owned(owner, id);
    if (app.status !== 'running' || app.desired !== 'running') fail('Application is not running.', 409);
    const payload = Buffer.from(JSON.stringify({ app: id, version: app.access_version,
      kind: share ? 'share' : 'private', exp: Math.floor(Date.now() / 1000) + (share ? 7 * 86400 : 60),
      nonce: crypto.randomBytes(16).toString('hex') })).toString('base64url');
    const signature = crypto.createHmac('sha256', this.signingKey).update(payload).digest('base64url');
    return { url: `https://${app.hostname}/_vs/auth?grant=${payload}.${signature}`, expiresIn: share ? 7 * 86400 : 60 };
  }
  revoke(owner: string, id: string) {
    this.owned(owner, id);
    this.db.prepare('UPDATE applications SET access_version=access_version+1,updated_at=? WHERE id=?').run(new Date().toISOString(), id);
    return { revoked: true };
  }
  close() { this.db.close(); }
}
