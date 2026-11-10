import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CodexAppServerClient } from '../codex-app-server.service.js';

/**
 * A request that times out used to leave nothing behind but the rejection: no time,
 * and a response arriving later was dropped without a trace. So when a resume took
 * 30 s on the shared app-server, nothing said whether it was slow or lost.
 */
async function createSlowCodex(scriptPath, responseGatePath) {
  await writeFile(scriptPath, `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    process.stdout.write(JSON.stringify({ id: message.id, result: { userAgent: 'fake' } }) + '\\n');
  } else if (message.method === 'thread/resume') {
    const gate = setInterval(() => {
      if (!fs.existsSync(${JSON.stringify(responseGatePath)})) return;
      clearInterval(gate);
      setTimeout(() => {
        process.stdout.write(JSON.stringify({ id: message.id, result: { blob: 'x'.repeat(1000) } }) + '\\n');
      }, 250);
    }, 5);
  }
});
`, 'utf8');
  await chmod(scriptPath, 0o755);
}

test('a timed-out request is logged with time and method, and its late response with size and lateness', async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-timeout-'));
  const executable = path.join(tempRoot, 'fake-codex');
  const responseGatePath = path.join(tempRoot, 'release-response');
  const previousPath = process.env.VIBESPACE_CODEX_PATH;
  const logged = [];
  t.mock.method(console, 'error', (...args) => logged.push(args.join(' ')));
  let client;

  try {
    await createSlowCodex(executable, responseGatePath);
    process.env.VIBESPACE_CODEX_PATH = executable;
    client = new CodexAppServerClient({ env: process.env });

    await assert.rejects(
      client.request('thread/resume', { threadId: 'thread-1' }, 50),
      /Codex app-server thread\/resume timed out/,
    );
    const timeoutLine = logged.find((line) => line.includes('timed out after'));
    assert.match(timeoutLine, /^\[Codex app-server\] \d{4}-\d{2}-\d{2}T[\d:.]+Z thread\/resume id=\d+ thread=thread-1 timed out after 50ms$/);

    // Start the late-response delay after the timeout actually fired. Under load,
    // the parent's timeout callback can run much later than its nominal 50 ms.
    await writeFile(responseGatePath, '');

    const deadline = Date.now() + 5_000;
    while (!logged.some((line) => line.includes('after its timeout')) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const lateLine = logged.find((line) => line.includes('after its timeout'));
    assert.ok(lateLine, 'the late response must be reported');
    const match = lateLine.match(/thread\/resume id=\d+ answered (\d+)ms after its timeout \((\d+) bytes, result\)$/);
    assert.ok(match, lateLine);
    assert.ok(Number(match[1]) >= 100, `lateness ${match[1]}ms`);
    assert.ok(Number(match[2]) > 1000, `size ${match[2]} bytes`);
  } finally {
    client?.stop();
    if (previousPath === undefined) delete process.env.VIBESPACE_CODEX_PATH;
    else process.env.VIBESPACE_CODEX_PATH = previousPath;
    await rm(tempRoot, { recursive: true, force: true });
  }
});
