import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAgentEnv,
  collectAgentEnv,
  isServerOnlyEnvKey,
  registerAgentEnvContributor,
  registerServerConfigKey,
} from '@/shared/agent-env.js';

test('the port that made agent dev servers squat VibeSpace is not forwarded', () => {
  const env = buildAgentEnv({}, { PORT: '7001', SERVER_PORT: '7001', HOST: '10.6.0.3' });

  assert.equal(env.PORT, undefined);
  assert.equal(env.SERVER_PORT, undefined);
  assert.equal(env.HOST, undefined);
});

test("VibeSpace's own auth material is not forwarded", () => {
  const env = buildAgentEnv({}, {
    JWT_SECRET: 'signing-key',
    API_KEY: 'server-api-key',
    VS_WORKER_TOKEN: 'worker-token',
    VOICE_API_KEY: 'voice-key',
    CLOUDCLI_BROWSER_USE_MCP_TOKEN: 'mcp-token',
    DATABASE_PATH: '/Users/someone/.vibespace/auth.db',
  });

  assert.deepEqual(Object.keys(env), []);
});

test('every VS_OIDC_ key is stripped, including ones nobody enumerated', () => {
  const env = buildAgentEnv({}, {
    VS_OIDC_CLIENT_SECRET: 'secret',
    VS_OIDC_CLIENT_ID: 'id',
    VS_OIDC_SOMETHING_ADDED_LATER: 'x',
  });

  assert.deepEqual(Object.keys(env), []);
});

test('credentials the agent genuinely needs still reach it', () => {
  // The whole reason this is a denylist: matching /SECRET|TOKEN|KEY/ would strip
  // exactly the credentials that make the agent work.
  const env = buildAgentEnv({}, {
    ANTHROPIC_API_KEY: 'sk-ant',
    ANTHROPIC_AUTH_TOKEN: 'auth',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
    ANTHROPIC_BASE_URL: 'https://example.invalid',
    ANTHILL_SERVICE_TOKEN: 'anthill',
    PATH: '/usr/bin',
    HOME: '/Users/someone',
  });

  assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'auth');
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'oauth');
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://example.invalid');
  assert.equal(env.ANTHILL_SERVICE_TOKEN, 'anthill');
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/Users/someone');
});

test('overrides are applied after filtering so callers can still set a key', () => {
  // opencode passes its permission flags this way.
  const env = buildAgentEnv(
    { OPENCODE_PERMISSION: '{"edit":"allow"}' },
    { PORT: '7001', PATH: '/usr/bin' },
  );

  assert.equal(env.OPENCODE_PERMISSION, '{"edit":"allow"}');
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.PORT, undefined);
});

test('an undefined value is dropped rather than forwarded as "undefined"', () => {
  const env = buildAgentEnv({}, { DEFINED: 'yes', MISSING: undefined });

  assert.equal(env.DEFINED, 'yes');
  assert.ok(!('MISSING' in env));
});

test('a key registered from .env at runtime becomes server-only', () => {
  const key = 'VIBESPACE_TEST_ENV_ONLY_KEY';

  assert.equal(isServerOnlyEnvKey(key), false);
  registerServerConfigKey(key);
  assert.equal(isServerOnlyEnvKey(key), true);

  assert.equal(buildAgentEnv({}, { [key]: 'from-dotenv' })[key], undefined);
});

// ----------------- contributors ------------

test('collectAgentEnv merges contributors in order and survives a throwing one', () => {
  const unregisterA = registerAgentEnvContributor((ctx) => (ctx.private ? { A: '1', SHARED: 'a' } : null));
  const unregisterBoom = registerAgentEnvContributor(() => {
    throw new Error('boom');
  });
  const unregisterB = registerAgentEnvContributor((ctx) => (ctx.scope === 'session' ? { SHARED: 'b' } : undefined));
  try {
    assert.deepEqual(
      collectAgentEnv({ provider: 'claude', scope: 'session', private: true }),
      { A: '1', SHARED: 'b' },
    );
    assert.deepEqual(collectAgentEnv({ provider: 'codex', scope: 'server', private: false }), {});
  } finally {
    unregisterA();
    unregisterBoom();
    unregisterB();
  }
  assert.deepEqual(collectAgentEnv({ provider: 'claude', scope: 'session', private: true }), {});
});
