import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { getCodexAppServer, stopCodexAppServer } from '../codex-app-server.service.js';
import { registerAgentEnvContributor } from '../../shared/agent-env.js';

/**
 * A Codex session is hosted by whichever app-server started its thread, and
 * anything reading that server's own environment (a presence reporter's gate)
 * sees one value for every thread. So a private session (FEAT-INGEST-006)
 * needs an app-server of its own, spawned with whatever host plugins
 * contribute for the private variant — and the ordinary one must stay exactly
 * what it was, with nothing contributed at all.
 */
const unregisterContributor = registerAgentEnvContributor((context) =>
  context.scope === 'server' && context.private ? { VS_TEST_OPT_OUT: '1' } : null,
);
test.after(() => unregisterContributor());

/** A fake `codex app-server` that answers `initialize` and records its env. */
async function createFakeCodex(scriptPath) {
  await writeFile(scriptPath, `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
fs.appendFileSync(process.env.VIBESPACE_CODEX_CAPTURE, JSON.stringify({
  pid: process.pid,
  optOut: process.env.VS_TEST_OPT_OUT ?? null,
  path: process.env.PATH,
}) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    process.stdout.write(JSON.stringify({ id: message.id, result: { userAgent: 'fake' } }) + '\\n');
  }
});
`, 'utf8');
  await chmod(scriptPath, 0o755);
}

test('a private session gets its own app-server carrying the private-variant env; the shared one has none', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-private-'));
  const executable = path.join(tempRoot, 'fake-codex');
  const capturePath = path.join(tempRoot, 'spawns.jsonl');
  const previousPath = process.env.VIBESPACE_CODEX_PATH;
  const previousCapture = process.env.VIBESPACE_CODEX_CAPTURE;
  const previousOptOut = process.env.VS_TEST_OPT_OUT;

  try {
    await createFakeCodex(executable);
    process.env.VIBESPACE_CODEX_PATH = executable;
    process.env.VIBESPACE_CODEX_CAPTURE = capturePath;
    delete process.env.VS_TEST_OPT_OUT;

    const shared = await getCodexAppServer();
    const privateServer = await getCodexAppServer({ private: true });
    const sharedAgain = await getCodexAppServer({ private: false });
    const privateAgain = await getCodexAppServer({ private: true });

    // Two processes, not four: each variant is shared by every session of its kind.
    assert.notEqual(shared, privateServer);
    assert.equal(shared, sharedAgain);
    assert.equal(privateServer, privateAgain);

    const spawns = (await readFile(capturePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(spawns.length, 2);
    assert.deepEqual(spawns.map((spawn) => spawn.optOut), [null, '1']);
    // The gate rides on the host env rather than replacing it.
    assert.equal(spawns[1].path, process.env.PATH);
  } finally {
    stopCodexAppServer();
    if (previousPath === undefined) delete process.env.VIBESPACE_CODEX_PATH;
    else process.env.VIBESPACE_CODEX_PATH = previousPath;
    if (previousCapture === undefined) delete process.env.VIBESPACE_CODEX_CAPTURE;
    else process.env.VIBESPACE_CODEX_CAPTURE = previousCapture;
    if (previousOptOut !== undefined) process.env.VS_TEST_OPT_OUT = previousOptOut;
    await rm(tempRoot, { recursive: true, force: true });
  }
});
