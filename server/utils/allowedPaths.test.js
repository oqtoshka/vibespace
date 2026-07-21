import assert from 'node:assert/strict';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { getAdditionalFileRoots, validateAccessiblePath, validatePathInProject } from './allowedPaths.js';

let tmp;
let project;
let outside;

before(async () => {
    // realpath: on macOS os.tmpdir() is itself a symlink into /private, and the
    // whole point of these tests is that the resolver copes with that.
    tmp = await fsPromises.realpath(await fsPromises.mkdtemp(path.join(os.tmpdir(), 'allowed-paths-')));
    project = path.join(tmp, 'project');
    outside = path.join(tmp, 'outside');
    await fsPromises.mkdir(path.join(project, 'src'), { recursive: true });
    await fsPromises.mkdir(outside, { recursive: true });
    await fsPromises.writeFile(path.join(project, 'src', 'index.js'), '// in project\n');
    await fsPromises.writeFile(path.join(outside, 'notes.md'), '# outside\n');
});

after(async () => {
    await fsPromises.rm(tmp, { recursive: true, force: true });
});

describe('validatePathInProject', () => {
    test('accepts the project root itself', () => {
        // Regression: the root used to fail its own check, which is what made
        // the top-level breadcrumb segments render "Failed to load".
        const result = validatePathInProject(project, project);
        assert.equal(result.valid, true);
        assert.equal(result.resolved, project);
    });

    test('accepts descendants, by absolute and by relative path', () => {
        assert.equal(validatePathInProject(project, path.join(project, 'src', 'index.js')).valid, true);
        assert.equal(validatePathInProject(project, 'src/index.js').valid, true);
    });

    test('rejects a sibling whose name merely prefixes the root', () => {
        assert.equal(validatePathInProject(project, `${project}-old/secret`).valid, false);
    });

    test('rejects traversal out of the project', () => {
        assert.equal(validatePathInProject(project, '../outside/notes.md').valid, false);
    });
});

describe('validateAccessiblePath', () => {
    test('falls through to an additional root for an out-of-project file', async () => {
        const result = await validateAccessiblePath(project, path.join(outside, 'notes.md'), [outside]);
        assert.equal(result.valid, true);
        assert.equal(result.outsideProject, true);
    });

    test('still reports in-project paths as in-project', async () => {
        const result = await validateAccessiblePath(project, 'src/index.js', [outside]);
        assert.equal(result.valid, true);
        assert.notEqual(result.outsideProject, true);
    });

    test('rejects a path under no configured root', async () => {
        const result = await validateAccessiblePath(project, path.join(tmp, 'elsewhere.txt'), [outside]);
        assert.equal(result.valid, false);
        assert.match(result.error, /configured additional root/);
    });

    test('rejects with no additional roots configured', async () => {
        const result = await validateAccessiblePath(project, path.join(outside, 'notes.md'), []);
        assert.equal(result.valid, false);
    });

    test('allows a file that does not exist yet under an allowed root', async () => {
        // Save-as and first-write go through the same check, so a missing target
        // has to validate via its parent rather than fail closed.
        const result = await validateAccessiblePath(project, path.join(outside, 'new-file.md'), [outside]);
        assert.equal(result.valid, true);
    });

    test('refuses a symlink that escapes an allowed root', async () => {
        const escape = path.join(outside, 'escape');
        await fsPromises.symlink(path.join(tmp, 'elsewhere'), escape);
        await fsPromises.mkdir(path.join(tmp, 'elsewhere'), { recursive: true });
        await fsPromises.writeFile(path.join(tmp, 'elsewhere', 'secret.txt'), 'nope\n');

        const result = await validateAccessiblePath(project, path.join(escape, 'secret.txt'), [outside]);
        assert.equal(result.valid, false, 'a symlink inside an allowed root must not widen it');
    });

    test('accepts children of a symlinked root', async () => {
        // The mirror image of the case above: the root is reached through a
        // symlink, but the target really is inside it.
        const linkedRoot = path.join(tmp, 'linked-root');
        await fsPromises.symlink(outside, linkedRoot);

        const result = await validateAccessiblePath(project, path.join(linkedRoot, 'notes.md'), [linkedRoot]);
        assert.equal(result.valid, true);
    });
});

describe('getAdditionalFileRoots', () => {
    test('defaults to the workspace root', () => {
        const roots = getAdditionalFileRoots({ WORKSPACES_ROOT: outside });
        assert.deepEqual(roots, [outside]);
    });

    test('appends delimiter-separated extras and de-duplicates', () => {
        const roots = getAdditionalFileRoots({
            WORKSPACES_ROOT: outside,
            VS_EXTRA_FILE_ROOTS: [project, outside].join(path.delimiter),
        });
        assert.deepEqual(roots, [outside, project]);
    });

    test('ignores blank entries', () => {
        const roots = getAdditionalFileRoots({
            WORKSPACES_ROOT: outside,
            VS_EXTRA_FILE_ROOTS: `${path.delimiter}  ${path.delimiter}`,
        });
        assert.deepEqual(roots, [outside]);
    });
});
