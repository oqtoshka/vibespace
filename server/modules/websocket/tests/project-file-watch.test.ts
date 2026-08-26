import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.NODE_TEST_CONTEXT = '1';

const { projectsDb } = await import('@/modules/database/index.js');
const {
  subscribeFilePath,
  unsubscribeFilePath,
  unsubscribeAllFilePaths,
  activeFileWatchCount,
} = await import('@/modules/websocket/services/project-files-watcher.service.js');

type Frame = { kind: string; path: string; type: string };

function fakeSocket() {
  const frames: Frame[] = [];
  return {
    frames,
    ws: { readyState: 1, send: (raw: string) => frames.push(JSON.parse(raw) as Frame) } as unknown as import('ws').WebSocket,
  };
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 6_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test('a per-file watch reports writes under an ignored dir, and stops with its last subscriber', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-file-watch-'));
  // `dist/` is on the project watcher's ignore list — exactly the case the
  // per-file watch exists for.
  const target = path.join(root, 'dist', 'report.html');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, '<h1>v1</h1>');

  const original = projectsDb.getProjectPathById;
  (projectsDb as { getProjectPathById: unknown }).getProjectPathById = async (id: string) => (id === 'p1' ? root : null);
  const { ws, frames } = fakeSocket();
  try {
    await subscribeFilePath(ws, 'p1', target);
    await subscribeFilePath(ws, 'p1', target); // a second viewer of the same file
    assert.equal(activeFileWatchCount(), 1);

    // fs.watchFile needs the mtime to move; make sure it does.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    fs.writeFileSync(target, '<h1>v2</h1>');
    await waitFor(() => frames.length > 0, 'a file_changed frame');
    assert.equal(frames[0].kind, 'file_changed');
    assert.equal(frames[0].path, target);
    assert.equal(frames[0].type, 'change');

    unsubscribeFilePath(ws, 'p1', target);
    assert.equal(activeFileWatchCount(), 1, 'one subscriber left');
    unsubscribeFilePath(ws, 'p1', target);
    assert.equal(activeFileWatchCount(), 0, 'poll stops with the last subscriber');
  } finally {
    unsubscribeAllFilePaths(ws);
    (projectsDb as { getProjectPathById: unknown }).getProjectPathById = original;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a path outside every allowed root is ignored, not watched', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-file-watch-root-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-file-watch-outside-'));
  const original = projectsDb.getProjectPathById;
  (projectsDb as { getProjectPathById: unknown }).getProjectPathById = async () => root;
  const previousExtra = process.env.VS_EXTRA_FILE_ROOTS;
  const previousWorkspaces = process.env.WORKSPACES_ROOT;
  process.env.VS_EXTRA_FILE_ROOTS = '';
  process.env.WORKSPACES_ROOT = root;
  const { ws } = fakeSocket();
  try {
    await subscribeFilePath(ws, 'p1', path.join(outside, 'secret.txt'));
    assert.equal(activeFileWatchCount(), 0);
  } finally {
    unsubscribeAllFilePaths(ws);
    (projectsDb as { getProjectPathById: unknown }).getProjectPathById = original;
    if (previousExtra === undefined) delete process.env.VS_EXTRA_FILE_ROOTS; else process.env.VS_EXTRA_FILE_ROOTS = previousExtra;
    if (previousWorkspaces === undefined) delete process.env.WORKSPACES_ROOT; else process.env.WORKSPACES_ROOT = previousWorkspaces;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
