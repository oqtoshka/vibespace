/**
 * Path containment rules for the file API.
 *
 * Two levels, deliberately different in reach:
 *
 * - `validatePathInProject` — the project root and its descendants. Used by the
 *   mutating file-management routes (create/rename/move/delete/upload), which
 *   have no reason to operate outside the project the user is looking at.
 *
 * - `validateAccessiblePath` — the project root *plus* a configured set of
 *   additional roots. Used wherever the user opens a specific path: reading a
 *   file, saving it back, and listing the directory around it. The agent
 *   regularly edits files just outside the project it was started in — a
 *   sibling repo, a config in its home — and every attempt to open one came
 *   back 403, so there was no way to read what had just been written.
 *
 * The additional roots default to `WORKSPACES_ROOT` because
 * `/api/browse-filesystem` already exposes that whole tree to any authenticated
 * caller. Honouring it here widens no trust boundary; it stops the file
 * endpoints from being stricter than the file browser sitting next to them.
 * Deployments needing more (the agent's `~/.claude`, a shared cache) list them
 * in `VS_EXTRA_FILE_ROOTS`, delimiter-separated. Deployments needing less
 * narrow `WORKSPACES_ROOT` itself, which the per-tenant containers already do.
 */

import fsPromises from 'fs/promises';
import path from 'path';

import { WORKSPACES_ROOT } from '@/shared/utils.js';

/**
 * Directories the file API may serve in addition to the project root.
 *
 * Read from the environment on every call rather than cached at import time, so
 * a test (or a reloaded config) can change it without re-importing the module.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]} absolute, de-duplicated roots
 */
export function getAdditionalFileRoots(env = process.env) {
    const configured = [
        env.WORKSPACES_ROOT || WORKSPACES_ROOT,
        ...(env.VS_EXTRA_FILE_ROOTS || '').split(path.delimiter),
    ];

    const roots = configured
        .map((entry) => (entry || '').trim())
        .filter(Boolean)
        .map((entry) => path.resolve(entry));

    return [...new Set(roots)];
}

/**
 * Resolve a path to its real location on disk.
 *
 * When the target does not exist yet, resolve its parent and re-attach the
 * name: a file about to be created still has to validate, and it has to
 * validate through the *real* parent rather than a lexical one.
 *
 * @param {string} target
 * @returns {Promise<string>}
 */
async function toRealPath(target) {
    try {
        return await fsPromises.realpath(target);
    } catch {
        try {
            return path.join(await fsPromises.realpath(path.dirname(target)), path.basename(target));
        } catch {
            return target;
        }
    }
}

const isInsideDir = (root, target) => target === root || target.startsWith(root + path.sep);

/**
 * Validate that a path is within the project root.
 *
 * @param {string} projectRoot - The project root path
 * @param {string} targetPath - The path to validate
 * @returns {{ valid: boolean, resolved?: string, error?: string }}
 */
export function validatePathInProject(projectRoot, targetPath) {
    const resolved = path.isAbsolute(targetPath)
        ? path.resolve(targetPath)
        : path.resolve(projectRoot, targetPath);

    // The root itself is inside the project. Comparing against `root + sep`
    // alone excluded it, which broke the top-level breadcrumb segments: their
    // parent directory *is* the project root, so browsing them 400'd and the
    // menu rendered "Failed to load". The separator is still required for the
    // descendant case so that a sibling like `/project-old` cannot match
    // `/project`.
    const normalizedRoot = path.resolve(projectRoot);
    if (!isInsideDir(normalizedRoot, resolved)) {
        return { valid: false, error: 'Path must be under project root' };
    }
    return { valid: true, resolved };
}

/**
 * Validate a path against the project root and the additional roots.
 *
 * @param {string} projectRoot
 * @param {string} targetPath
 * @param {string[]} [additionalRoots]
 * @returns {Promise<{ valid: boolean, resolved?: string, error?: string, outsideProject?: boolean }>}
 */
export async function validateAccessiblePath(projectRoot, targetPath, additionalRoots = getAdditionalFileRoots()) {
    const inProject = validatePathInProject(projectRoot, targetPath);
    if (inProject.valid) {
        return inProject;
    }

    const resolved = path.isAbsolute(targetPath)
        ? path.resolve(targetPath)
        : path.resolve(projectRoot, targetPath);

    // Containment is judged on real paths only. Comparing lexically as well
    // would let a symlink planted inside an allowed root point anywhere on the
    // disk, and it is unnecessary: resolving both sides already makes a
    // symlinked root (/tmp on macOS) match its own children.
    const realResolved = await toRealPath(resolved);
    for (const root of additionalRoots) {
        const realRoot = await toRealPath(root);
        if (isInsideDir(realRoot, realResolved)) {
            return { valid: true, resolved, outsideProject: true };
        }
    }

    return {
        valid: false,
        error: 'Path must be under the project root or a configured additional root',
    };
}
