import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import http from 'node:http';

import { loadManagerConfig } from '../config.js';
import { createStaticBackend, WorkerUnavailableError } from '../backends/static.js';

const USER_MAP = {
  main: { passwordHash: '$2b$12$abcdefghijklmnopqrstuv', upstream: 'http://127.0.0.1:7100' },
  sanyaz: { passwordHash: '$2b$12$abcdefghijklmnopqrstuv', upstream: 'http://127.0.0.1:7101', enabled: false },
};

const encoded = (value) => Buffer.from(JSON.stringify(value)).toString('base64');

const baseEnv = (overrides = {}) => ({
  VS_MANAGER_USERS_B64: encoded(USER_MAP),
  VS_MANAGER_JWT_SECRET: 'secret',
  ...overrides,
});

describe('loadManagerConfig', () => {
  it('decodes the base64 user map into credentials and links', () => {
    const config = loadManagerConfig(baseEnv());

    assert.equal(config.credentials.get('main'), USER_MAP.main.passwordHash);
    assert.equal(config.links.get('main').upstream, 'http://127.0.0.1:7100');
    assert.equal(config.links.get('main').user_id, 'main');
  });

  it('accepts the plain JSON form for local development', () => {
    const config = loadManagerConfig({
      VS_MANAGER_USERS: JSON.stringify(USER_MAP),
      VS_MANAGER_JWT_SECRET: 'secret',
    });

    assert.equal(config.links.size, 2);
  });

  it('treats a user as enabled unless it says otherwise', () => {
    const config = loadManagerConfig(baseEnv());

    assert.equal(config.links.get('main').enabled, true);
    assert.equal(config.links.get('sanyaz').enabled, false);
  });

  it('applies defaults for port and backend selection', () => {
    const config = loadManagerConfig(baseEnv());

    assert.equal(config.port, 7000);
    assert.equal(config.authKind, 'password');
    assert.equal(config.backendKind, 'static');
  });

  it('honours explicit port and backend settings', () => {
    const config = loadManagerConfig(baseEnv({ VS_MANAGER_PORT: '7001', VS_WORKER_BACKEND: 'static' }));

    assert.equal(config.port, 7001);
  });

  it('rejects a missing user map rather than starting with nobody able to log in', () => {
    assert.throws(() => loadManagerConfig({}), /VS_MANAGER_USERS_B64/);
  });

  it('rejects malformed base64 and JSON', () => {
    assert.throws(() => loadManagerConfig(baseEnv({ VS_MANAGER_USERS_B64: 'bm90LWpzb24=' })), /not valid JSON/);
  });

  it('rejects an entry with no upstream', () => {
    assert.throws(
      () => loadManagerConfig(baseEnv({ VS_MANAGER_USERS_B64: encoded({ main: { passwordHash: 'x' } }) })),
      /missing upstream/
    );
  });

  it('rejects an invalid upstream URL at boot', () => {
    assert.throws(
      () =>
        loadManagerConfig(
          baseEnv({ VS_MANAGER_USERS_B64: encoded({ main: { passwordHash: 'x', upstream: 'not a url' } }) })
        ),
      /invalid upstream/
    );
  });

  it('rejects an empty user map', () => {
    assert.throws(() => loadManagerConfig(baseEnv({ VS_MANAGER_USERS_B64: encoded({}) })), /empty/);
  });

  it('generates an ephemeral secret when none is configured', () => {
    const config = loadManagerConfig({ VS_MANAGER_USERS_B64: encoded(USER_MAP) });

    assert.equal(typeof config.jwtSecret, 'string');
    assert.ok(config.jwtSecret.length >= 32);
  });
});

describe('static worker backend', () => {
  let healthy;
  let backend;
  let port;

  before(async () => {
    healthy = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"status":"ok"}');
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise((resolve) => healthy.listen(0, '127.0.0.1', resolve));
    port = healthy.address().port;

    backend = createStaticBackend({
      links: new Map([
        ['main', { user_id: 'main', upstream: `http://127.0.0.1:${port}`, workerToken: 'tok', enabled: true }],
        ['down', { user_id: 'down', upstream: 'http://127.0.0.1:1', enabled: true }],
      ]),
    });
  });

  after(() => healthy.close());

  it('resolves a reachable worker to its address and token', async () => {
    const entry = await backend.getOrStartWorker({
      user_id: 'main',
      upstream: `http://127.0.0.1:${port}`,
      workerToken: 'tok',
    });

    assert.equal(entry.host, '127.0.0.1');
    assert.equal(entry.port, port);
    assert.equal(entry.workerToken, 'tok');
  });

  it('raises WorkerUnavailableError when the worker does not answer', async () => {
    await assert.rejects(
      () => backend.getOrStartWorker({ user_id: 'down', upstream: 'http://127.0.0.1:1' }),
      WorkerUnavailableError
    );
  });

  it('exposes lifecycle hooks the manager calls on every request', () => {
    // Static workers outlive the manager, so these are no-ops — but they must
    // exist and stay callable, since backends that own worker processes rely on
    // the manager invoking them at these points.
    assert.doesNotThrow(() => {
      backend.touch('main');
      backend.noteWebSocketOpened('main');
      backend.noteWebSocketClosed('main');
      backend.invalidateWorker('main', {});
    });
  });

  it('re-probes after invalidation', async () => {
    const link = { user_id: 'main', upstream: `http://127.0.0.1:${port}`, workerToken: 'tok' };
    await backend.getOrStartWorker(link);
    backend.invalidateWorker('main');

    const entry = await backend.getOrStartWorker(link);
    assert.equal(entry.port, port);
  });
});
