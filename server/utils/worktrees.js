/**
 * Git worktree support.
 *
 * Worktrees let one repo have multiple branch checkouts in separate directories,
 * so an agent can work an isolated feature branch without touching the main tree.
 *
 * vibespace stores them centrally under the app data dir:
 *   <dataDir>/worktrees/<projectId>/<branchSlug>/
 * The projectId in the path lets the session synchronizer reverse-map a
 * worktree session (whose transcript cwd is the worktree dir) back to its parent
 * project instead of surfacing it as a stray standalone project.
 */

import path from 'path';
import os from 'os';
import { promises as fs } from 'fs';
import { execFile } from 'child_process';

function git(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        error.stdout = stdout;
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

/** The app data directory (parent of auth.db), e.g. ~/.vibespace. */
export function getDataDir() {
  const dbPath = process.env.DATABASE_PATH || path.join(os.homedir(), '.vibespace', 'auth.db');
  return path.dirname(dbPath);
}

/** Base dir holding every project's worktrees: <dataDir>/worktrees. */
export function worktreesBaseDir() {
  return path.join(getDataDir(), 'worktrees');
}

/** Where a given project's worktrees live: <dataDir>/worktrees/<projectId>. */
export function worktreesRootForProject(projectId) {
  return path.join(worktreesBaseDir(), projectId);
}

/** Filesystem-safe slug for a branch name (keeps it readable). */
export function slugForBranch(branch) {
  return String(branch)
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'worktree';
}

/** Short branch label from a `refs/heads/...` ref or a raw name. */
export function shortBranch(ref) {
  if (!ref) return null;
  return ref.replace(/^refs\/heads\//, '');
}

/**
 * Parses `git worktree list --porcelain` for a repo.
 * @returns {Promise<Array<{path:string, head:string|null, branch:string|null, isMain:boolean, detached:boolean, locked:boolean, bare:boolean}>>}
 */
export async function listWorktrees(repoPath) {
  let stdout;
  try {
    ({ stdout } = await git(['worktree', 'list', '--porcelain'], repoPath));
  } catch {
    return [];
  }
  const worktrees = [];
  let current = null;
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trimEnd();
    if (line.startsWith('worktree ')) {
      if (current) worktrees.push(current);
      current = {
        path: line.slice('worktree '.length),
        head: null,
        branch: null,
        detached: false,
        locked: false,
        bare: false,
        isMain: false,
      };
    } else if (!current) {
      continue;
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ')) {
      current.branch = shortBranch(line.slice('branch '.length));
    } else if (line === 'detached') {
      current.detached = true;
    } else if (line === 'bare') {
      current.bare = true;
    } else if (line === 'locked' || line.startsWith('locked ')) {
      current.locked = true;
    }
  }
  if (current) worktrees.push(current);
  // The first entry git lists is the main working tree.
  if (worktrees.length > 0) worktrees[0].isMain = true;
  return worktrees;
}

/**
 * Validates a candidate worktree directory by confirming git lists it as a
 * worktree of `repoPath` — the authoritative membership check, used instead of
 * the project-root prefix rule so worktrees under ~/.vibespace are allowed.
 * @returns {Promise<{ path:string, branch:string|null } | null>}
 */
export async function resolveWorktreeCwd(repoPath, worktreePath) {
  if (!worktreePath || typeof worktreePath !== 'string' || worktreePath.includes('\0')) {
    return null;
  }
  const realOrResolve = async (p) => {
    try {
      return await fs.realpath(p);
    } catch {
      return path.resolve(p);
    }
  };

  const wanted = path.resolve(worktreePath);
  const wantedReal = await realOrResolve(worktreePath);
  const worktrees = await listWorktrees(repoPath);
  for (const wt of worktrees) {
    const listed = path.resolve(wt.path);
    const listedReal = await realOrResolve(wt.path);
    if (listed === wanted || listedReal === wantedReal) {
      return { path: listed, branch: wt.branch };
    }
  }
  return null;
}

/**
 * If `absCwd` is inside <dataDir>/worktrees/<projectId>/<slug>, returns the
 * owning projectId and the worktree path. Used by the session synchronizer to
 * attach worktree sessions to their parent project.
 * @returns {{ projectId:string, worktreePath:string } | null}
 */
export function parentProjectFromWorktreeCwd(absCwd) {
  if (!absCwd || typeof absCwd !== 'string') return null;
  const base = worktreesBaseDir();
  const resolved = path.resolve(absCwd);
  const baseWithSep = base + path.sep;
  if (!resolved.startsWith(baseWithSep)) return null;
  const rest = resolved.slice(baseWithSep.length);
  const segments = rest.split(path.sep).filter(Boolean);
  if (segments.length < 2) return null; // need <projectId>/<slug>
  const projectId = segments[0];
  // The worktree root is <base>/<projectId>/<slug> (one level under projectId).
  const worktreePath = path.join(base, projectId, segments[1]);
  return { projectId, worktreePath };
}

/**
 * Creates a worktree for `repoPath` under the project's worktrees root.
 * @param {object} opts { repoPath, projectId, branch, createBranch?, base? }
 * @returns {Promise<{ path:string, branch:string }>}
 */
export async function addWorktree({ repoPath, projectId, branch, createBranch = false, base = null }) {
  const slug = slugForBranch(branch);
  const root = worktreesRootForProject(projectId);
  await fs.mkdir(root, { recursive: true });
  let dest = path.join(root, slug);
  // Avoid colliding with an existing dir/worktree slug.
  try {
    await fs.access(dest);
    dest = path.join(root, `${slug}-${Date.now().toString(36)}`);
  } catch {
    // free
  }

  const args = ['worktree', 'add'];
  if (createBranch) {
    args.push('-b', branch, dest);
    if (base) args.push(base);
  } else {
    args.push(dest, branch);
  }
  await git(args, repoPath);
  return { path: dest, branch };
}

/** Removes a worktree (validated as belonging to the repo). */
export async function removeWorktree({ repoPath, worktreePath, force = false }) {
  const resolved = await resolveWorktreeCwd(repoPath, worktreePath);
  if (!resolved) {
    throw new Error('Not a worktree of this repository');
  }
  const args = ['worktree', 'remove'];
  if (force) args.push('--force');
  args.push(resolved.path);
  await git(args, repoPath);
  return { removed: resolved.path };
}
