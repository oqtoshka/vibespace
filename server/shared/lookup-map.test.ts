import assert from 'node:assert/strict';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildLookupMap } from '@/shared/utils.js';

async function withTempDir(runTest: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lookup-map-'));
  try {
    await runTest(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const line = (sessionId: string, display: string) => JSON.stringify({ sessionId, display });

test('a rewritten index is re-read, and an unchanged one is not', async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, 'history.jsonl');
    await writeFile(filePath, `${line('a', 'first')}\n`, 'utf8');

    assert.equal((await buildLookupMap(filePath, 'sessionId', 'display')).get('a'), 'first');

    // Appending changes both size and mtime, so the next call must see it.
    await writeFile(filePath, `${line('a', 'second')}\n`, 'utf8');
    assert.equal((await buildLookupMap(filePath, 'sessionId', 'display')).get('a'), 'second');

    // Nothing changed on disk this time: the cached map comes back, which is
    // the whole point — this file is re-read on every watcher event.
    const cached = await buildLookupMap(filePath, 'sessionId', 'display');
    assert.equal(cached, await buildLookupMap(filePath, 'sessionId', 'display'));
    assert.equal(cached.get('a'), 'second');
  });
});

test('a same-size rewrite is still picked up through its mtime', async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, 'history.jsonl');
    await writeFile(filePath, `${line('a', 'aaaaa')}\n`, 'utf8');
    assert.equal((await buildLookupMap(filePath, 'sessionId', 'display')).get('a'), 'aaaaa');

    await writeFile(filePath, `${line('a', 'bbbbb')}\n`, 'utf8');
    // Force a distinct mtime: a rewrite inside the same filesystem timestamp
    // tick would otherwise look identical to the cached signature.
    const later = new Date(Date.now() + 2_000);
    await utimes(filePath, later, later);

    assert.equal((await buildLookupMap(filePath, 'sessionId', 'display')).get('a'), 'bbbbb');
  });
});

test('a missing index yields an empty map and is not cached as empty', async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, 'history.jsonl');

    assert.equal((await buildLookupMap(filePath, 'sessionId', 'display')).size, 0);

    // The file appearing later must not be shadowed by the failed lookup.
    await writeFile(filePath, `${line('a', 'first')}\n`, 'utf8');
    assert.equal((await buildLookupMap(filePath, 'sessionId', 'display')).get('a'), 'first');
  });
});
