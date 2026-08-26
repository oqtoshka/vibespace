import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { collectAgentEnv } from '@/shared/agent-env.js';
import {
  activateHostExtensions,
  activeHostExtensionNames,
  deactivateHostExtensions,
  getHostExtensionRouter,
} from '@/modules/plugins/index.js';

function writePlugin(root: string, dirName: string, name: string, body: string, enabled = true) {
  const dir = path.join(root, dirName);
  fs.mkdirSync(path.join(dir, 'host'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'host', 'index.js'), body);
  return { name, dirName, enabled, hostModule: 'host/index.js' };
}

function deps(root: string, plugins: ReturnType<typeof writePlugin>[]) {
  const shutdowns: string[] = [];
  return {
    shutdowns,
    deps: {
      scanPlugins: () => plugins,
      getPluginsDir: () => root,
      authenticateToken: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
      getSigningSecret: () => 'secret',
      sessions: {
        getById: (id: string) => (id === 'known' ? { session_id: id, provider: 'claude', provider_session_id: null, isArchived: false } : null),
        createAppSession: () => ({ sessionId: 'new' }),
        deleteOrArchiveById: async () => undefined,
        rename: () => undefined,
      },
      runs: {
        get: (id: string) => (id === 'known' ? { status: 'running' as const, providerSessionId: 'p1', lastAssistantText: 'hi' } : null),
        abort: async (id: string) => id === 'known',
      },
      enqueueMessage: () => true,
    },
  };
}

test('activates enabled host modules: routes mount, env contributors apply, shutdown hooks run', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-host-ext-'));
  const good = writePlugin(root, 'good', 'good', `
    export async function activate(host) {
      const r = host.createRouter();
      r.get('/ping', (req, res) => res.json({ pong: host.pluginName, known: Boolean(host.sessions.getById('known')), run: host.runs.get('known')?.status ?? null, mac: host.hmacSha256('x') }));
      host.mountRouter('/api/ext-test', r);
      host.registerAgentEnvContributor((ctx) => ctx.private ? { EXT_PRIVATE: '1' } : null);
      host.onShutdown(() => { globalThis.__extShutdown = (globalThis.__extShutdown ?? 0) + 1; });
    }
  `);
  const broken = writePlugin(root, 'broken', 'broken', `export function activate() { throw new Error('boom'); }`);
  const disabled = writePlugin(root, 'off', 'off', `export function activate() { globalThis.__offActivated = true; }`, false);
  const { deps: d } = deps(root, [good, broken, disabled]);

  try {
    const activated = await activateHostExtensions(d);
    assert.deepEqual(activated, ['good']);
    assert.deepEqual(activeHostExtensionNames(), ['good']);
    assert.equal((globalThis as Record<string, unknown>).__offActivated, undefined);

    assert.deepEqual(collectAgentEnv({ provider: 'claude', scope: 'session', private: true }), { EXT_PRIVATE: '1' });
    assert.deepEqual(collectAgentEnv({ provider: 'claude', scope: 'session', private: false }), {});

    const app = express();
    app.use(getHostExtensionRouter());
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    try {
      const { port } = server.address() as { port: number };
      const response = await fetch(`http://127.0.0.1:${port}/api/ext-test/ping`);
      assert.equal(response.status, 200);
      const body = (await response.json()) as { pong: string; known: boolean; run: string | null; mac: unknown };
      assert.equal(body.pong, 'good');
      assert.equal(body.known, true);
      assert.equal(body.run, 'running');
      assert.equal(typeof body.mac, 'string');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    await deactivateHostExtensions();
    assert.deepEqual(activeHostExtensionNames(), []);
    assert.equal((globalThis as Record<string, unknown>).__extShutdown, 1);
    // Contributors are gone with the extension.
    assert.deepEqual(collectAgentEnv({ provider: 'claude', scope: 'session', private: true }), {});
  } finally {
    await deactivateHostExtensions();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
