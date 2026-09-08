import crypto from 'node:crypto';

import Database from 'better-sqlite3';

type Links = { get(username: string): { enabled?: boolean; workspace_id?: string } | undefined; keys(): IterableIterator<string> };

/** Manager routes own workspace grants and recovery jobs; the privileged
 * deployment controller consumes this database to apply mounts and backups.
 * Workers never receive this database, a Docker socket, or backup credentials.
 */
export class WorkspaceControl {
  private readonly db: Database.Database;
  constructor(filename: string, private readonly links: Links) {
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS shares (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, recipient TEXT NOT NULL,
        path TEXT NOT NULL, kind TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL, created_at TEXT NOT NULL, error TEXT, access TEXT NOT NULL DEFAULT 'read',
        owner_workspace TEXT NOT NULL, recipient_workspace TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspace_jobs (
        id TEXT PRIMARY KEY, username TEXT NOT NULL, kind TEXT NOT NULL,
        snapshot TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL,
        result TEXT, error TEXT
      );
      CREATE TABLE IF NOT EXISTS workspace_snapshots (
        id TEXT PRIMARY KEY, username TEXT NOT NULL, created_at TEXT NOT NULL
      );
    `);
    const columns = new Set((this.db.pragma('table_info(shares)') as Array<{ name: string }>).map(column => column.name));
    for (const [column, fallback] of [['access', 'read'], ['owner_workspace', ''], ['recipient_workspace', '']]) {
      if (!columns.has(column)) this.db.exec(`ALTER TABLE shares ADD COLUMN ${column} TEXT NOT NULL DEFAULT '${fallback}'`);
    }
  }
  private requireUser(username: string): void {
    if (!this.links.get(username)?.enabled) throw Object.assign(new Error('Workspace access is unavailable.'), { status: 403 });
  }
  users(username: string): string[] {
    this.requireUser(username);
    return [...this.links.keys()].filter(user => user !== username && this.links.get(user)?.enabled);
  }
  list(username: string): object {
    this.requireUser(username);
    return {
      shares: this.db.prepare('SELECT id,owner,recipient,path,kind,status,created_at,error,access FROM shares WHERE owner=? OR recipient=? ORDER BY created_at DESC').all(username, username),
      snapshots: this.db.prepare('SELECT id,created_at FROM workspace_snapshots WHERE username=? ORDER BY created_at DESC').all(username),
      jobs: this.db.prepare('SELECT id,kind,snapshot,status,created_at,result,error FROM workspace_jobs WHERE username=? ORDER BY created_at DESC LIMIT 30').all(username),
    };
  }
  share(username: string, input: { recipient: string; path: string; kind: string; access: string }): object {
    this.requireUser(username);
    this.requireUser(input.recipient);
    if (input.recipient === username) throw new Error('Choose another user.');
    const parts = input.path.split('/');
    if (!input.path || input.path.length > 1024 || input.path.startsWith('/') || parts.some(part => !part || part === '.' || part === '..') || /[\0\r\n\\]/.test(input.path)) {
      throw new Error('Choose a folder relative to your workspace.');
    }
    if (!['read', 'write'].includes(input.access)) throw new Error('Access must be read or write.');
    if (!['folder', 'skill'].includes(input.kind)) throw new Error('Invalid sharing kind.');
    if (input.kind === 'skill' && (parts.length !== 2 || parts[0] !== 'skills' || !/^[a-zA-Z0-9_-]+$/.test(parts[1]))) {
      throw new Error('Share a skill as skills/<skill-name>.');
    }
    const id = crypto.randomUUID();
    const token = crypto.randomBytes(32).toString('base64url');
    this.db.prepare('INSERT INTO shares(id,owner,recipient,path,kind,token_hash,status,created_at,access,owner_workspace,recipient_workspace) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, username, input.recipient, input.path, input.kind, crypto.createHash('sha256').update(token).digest('hex'), 'invited', new Date().toISOString(), input.access, this.links.get(username)?.workspace_id || username, this.links.get(input.recipient)?.workspace_id || input.recipient);
    return { id, invitation: `/?workspaceShare=${token}` };
  }
  accept(username: string, token: string): object {
    this.requireUser(username);
    const share = this.db.prepare('SELECT id,recipient,status FROM shares WHERE token_hash=?').get(crypto.createHash('sha256').update(token).digest('hex')) as { id: string; recipient: string; status: string } | undefined;
    if (!share || share.recipient !== username || share.status !== 'invited') throw Object.assign(new Error('Invitation is unavailable for this account.'), { status: 404 });
    this.db.prepare("UPDATE shares SET status='requested' WHERE id=? AND status='invited'").run(share.id);
    return { id: share.id, status: 'requested' };
  }
  revoke(username: string, id: string): object {
    this.requireUser(username);
    const share = this.db.prepare('SELECT owner,recipient FROM shares WHERE id=?').get(id) as { owner: string; recipient: string } | undefined;
    if (!share || (share.owner !== username && share.recipient !== username)) throw Object.assign(new Error('Share not found.'), { status: 404 });
    this.db.prepare("UPDATE shares SET status='revoking' WHERE id=? AND status!='revoked'").run(id);
    return { id, status: 'revoking' };
  }
  backup(username: string, snapshot: string | null): object {
    this.requireUser(username);
    if (snapshot && !this.db.prepare('SELECT 1 FROM workspace_snapshots WHERE id=? AND username=?').get(snapshot, username)) {
      throw Object.assign(new Error('Recovery point not found.'), { status: 404 });
    }
    const pending = this.db.prepare("SELECT id FROM workspace_jobs WHERE username=? AND status IN ('queued','running')").get(username);
    if (pending) throw new Error('A workspace recovery operation is already running.');
    const id = crypto.randomUUID();
    this.db.prepare('INSERT INTO workspace_jobs(id,username,kind,snapshot,status,created_at) VALUES(?,?,?,?,?,?)')
      .run(id, username, snapshot ? 'restore' : 'backup', snapshot, 'queued', new Date().toISOString());
    return { id, status: 'queued' };
  }
  close(): void { this.db.close(); }
}
