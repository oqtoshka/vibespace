import path from 'node:path';
import { readFile, realpath, writeFile, rename, appendFile, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';

import { AppError } from '@/shared/index.js';

type Rule = { path: string; hidden?: boolean; readOnly?: boolean; displayName?: string; description?: string };
type Policy = { version: 1; root: string; rules: Rule[] };

function within(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

async function canonical(candidate: string): Promise<string> {
  try { return await realpath(candidate); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = path.dirname(candidate);
    if (parent === candidate) throw error;
    return path.join(await canonical(parent), path.basename(candidate));
  }
}

function parsePolicy(input: unknown): Policy {
  const parsed = input as Policy;
  if (parsed?.version !== 1 || typeof parsed.root !== 'string' || !path.isAbsolute(parsed.root)
    || !Array.isArray(parsed.rules) || parsed.rules.length > 500) throw new Error('Invalid policy');
  const seen = new Set<string>();
  for (const rule of parsed.rules) {
    if (!rule || typeof rule.path !== 'string' || rule.path.length > 1024 || path.isAbsolute(rule.path)
      || rule.path.split('/').some(part => !part || part === '.' || part === '..')
      || /[\\\x00-\x1f]/.test(rule.path) || seen.has(rule.path)
      || ['hidden', 'readOnly'].some(key => rule[key as 'hidden'] !== undefined && typeof rule[key as 'hidden'] !== 'boolean')
      || ['displayName', 'description'].some(key => rule[key as 'displayName'] !== undefined
        && (typeof rule[key as 'displayName'] !== 'string' || rule[key as 'displayName']!.length > 2000))) throw new Error('Invalid rule');
    seen.add(rule.path);
  }
  return { version: 1, root: path.resolve(parsed.root), rules: parsed.rules.map(({path, hidden, readOnly, displayName, description}) => ({path, hidden, readOnly, displayName, description})) };
}

function revision(policy: Policy | null): string {
  return createHash('sha256').update(JSON.stringify(policy)).digest('hex');
}

/** File-tree operations and the policy HTTP route share a deployment-owned policy.
 * A configured but missing/invalid file fails closed. No policy means ordinary local mode.
 * This protects UI/API mutations; shell-level protection still requires read-only mounts.
 */
export class WorkspacePolicy {
  private mutation = Promise.resolve();
  constructor(
    private readonly filename: () => string | undefined = () => process.env.VS_WORKSPACE_POLICY_FILE,
    private readonly administrators: string[] = [],
  ) {}

  canEdit(actor: string): boolean { return Boolean(this.filename()) && this.administrators.includes(actor); }

  async snapshot() {
    const policy = await this.read();
    return { policy, revision: revision(policy) };
  }

  async save(actor: string, rules: unknown, expectedRevision: string) {
    if (!this.canEdit(actor)) throw new AppError('Administrator access required.', {code:'EACCES',statusCode:403});
    const pending = this.mutation.then(async () => {
      const current = await this.read();
      if (!current || revision(current) !== expectedRevision) throw new AppError('Policy changed. Reload before saving.', {code:'POLICY_CONFLICT',statusCode:409});
      let next: Policy;
      try { next = parsePolicy({...current, rules}); }
      catch { throw new AppError('Invalid workspace rules.', {code:'INVALID_POLICY',statusCode:400}); }
      const filename = this.filename()!;
      const temporary = `${filename}.${randomUUID()}.tmp`;
      const change = { id: randomUUID(), actor, time: new Date().toISOString(), before: current, after: next };
      try {
        await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', {mode:0o644,flag:'wx'});
        // Audit intent before replacement; only the commit record proves applied state.
        await appendFile(`${filename}.audit.jsonl`, JSON.stringify({...change,state:'prepared'}) + '\n', {mode:0o600});
        await rename(temporary, filename);
        await appendFile(`${filename}.audit.jsonl`, JSON.stringify({id:change.id,state:'committed'}) + '\n', {mode:0o600});
      } finally { await unlink(temporary).catch(() => {}); }
      return {policy:next, revision:revision(next)};
    });
    this.mutation = pending.then(() => undefined, () => undefined);
    return pending;
  }

  async read(): Promise<Policy | null> {
    const filename = this.filename();
    if (!filename) return null;
    try {
      return parsePolicy(JSON.parse(await readFile(filename, 'utf8')));
    } catch {
      throw new AppError('Workspace policy is unavailable. Contact the administrator.', { code: 'EACCES', statusCode: 403 });
    }
  }

  async assertWritable(candidate: string): Promise<void> {
    const policy = await this.read();
    if (!policy) return;
    const absolute = path.resolve(candidate);
    const resolved = await canonical(absolute);
    for (const rule of policy.rules) {
      if (!rule.readOnly) continue;
      const protectedPath = path.resolve(policy.root, rule.path);
      const protectedRealPath = await canonical(protectedPath);
      // Test both spellings: symlink aliases and projects opened below the
      // workspace root must not bypass protection. Ancestors carry protected files.
      if (within(absolute, protectedPath) || within(protectedPath, absolute)
        || within(resolved, protectedRealPath) || within(protectedRealPath, resolved)) {
        throw new AppError('This path is managed by the administrator and is read-only.', {code:'EACCES',statusCode:403});
      }
    }
  }
}

/** Shared instance used by file-tree mutations, legacy composition routes and policy delivery. */
export const workspacePolicy = new WorkspacePolicy();
