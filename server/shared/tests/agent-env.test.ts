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
    ACME_SERVICE_TOKEN: 'acme',
    PATH: '/usr/bin',
    HOME: '/Users/someone',
  });

  assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'auth');
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'oauth');
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://example.invalid');
  assert.equal(env.ACME_SERVICE_TOKEN, 'acme');
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

test('collectAgentLaunchExtras concatenates instructions, merges MCP servers, survives a throwing contributor', async () => {
  const { collectAgentLaunchExtras, registerAgentLaunchContributor } = await import('@/shared/agent-env.js');
  const unregisterA = registerAgentLaunchContributor((context) => (
    context.launchOptions?.['acme.review']
      ? { instructions: 'A says hi', mcpServers: { a: { command: 'a' }, shared: { command: 'from-a' } }, allowedTools: ['mcp__a__look', 'mcp__a__look', ''] }
      : null
  ));
  const unregisterThrows = registerAgentLaunchContributor(() => { throw new Error('boom'); });
  const unregisterB = registerAgentLaunchContributor(() => ({ instructions: '  B says hi  ', mcpServers: { shared: { command: 'from-b' } } }));
  try {
    const chosen = collectAgentLaunchExtras({ provider: 'claude', scope: 'session', launchOptions: { 'acme.review': true } });
    assert.equal(chosen.instructions, 'A says hi\n\nB says hi');
    assert.deepEqual(chosen.mcpServers, { a: { command: 'a' }, shared: { command: 'from-b' } });
    assert.deepEqual(chosen.allowedTools, ['mcp__a__look']);

    const plain = collectAgentLaunchExtras({ provider: 'claude', scope: 'session' });
    assert.equal(plain.instructions, 'B says hi');
    assert.deepEqual(plain.mcpServers, { shared: { command: 'from-b' } });
    assert.deepEqual(plain.allowedTools, []);
  } finally {
    unregisterA();
    unregisterThrows();
    unregisterB();
  }
});

test('launch options: only declared ids are kept, values are true or a small object, strict refuses the unknown', async () => {
  const { listLaunchOptions, normalizeLaunchOptions, parseStoredLaunchOptions, registerLaunchOption } = await import('@/shared/agent-env.js');
  assert.throws(() => registerLaunchOption({ id: 'Bad Id', label: 'x' }));
  assert.throws(() => registerLaunchOption({ id: 'acme.review', label: ' ' }));
  const unregister = registerLaunchOption({ id: 'acme.review', label: 'review', hint: 'Reviewed elsewhere', providers: ['claude'] });
  try {
    assert.deepEqual(listLaunchOptions().map((option) => option.id), ['acme.review']);
    assert.equal(normalizeLaunchOptions(undefined), null);
    assert.equal(normalizeLaunchOptions({ 'acme.review': false }), null);
    assert.deepEqual(normalizeLaunchOptions({ 'acme.review': true, 'other.thing': true }), { 'acme.review': true });
    assert.deepEqual(normalizeLaunchOptions({ 'acme.review': { depth: 'deep' } }), { 'acme.review': { depth: 'deep' } });
    assert.throws(() => normalizeLaunchOptions({ 'other.thing': true }, { strict: true }), /Unknown launch option: other\.thing/);
    assert.throws(() => normalizeLaunchOptions({ 'acme.review': 'yes' }), /Invalid launch option/);
    assert.throws(() => normalizeLaunchOptions({ 'acme.review': { blob: 'x'.repeat(4096) } }), /Invalid launch option/);
    assert.throws(() => normalizeLaunchOptions(['acme.review']), /Invalid launch options/);
  } finally {
    unregister();
  }
  assert.deepEqual(listLaunchOptions(), []);
  assert.equal(normalizeLaunchOptions({ 'acme.review': true }), null);

  assert.deepEqual(parseStoredLaunchOptions('{"acme.review":true}'), { 'acme.review': true });
  for (const cell of [null, '', '{}', '[]', 'not json', 7]) assert.equal(parseStoredLaunchOptions(cell), null);
});

test('launch options: a marker and a banner are validated at registration and listed as declared', async () => {
  const { listLaunchOptions, registerLaunchOption } = await import('@/shared/agent-env.js');
  assert.throws(() => registerLaunchOption({ id: 'acme.review', label: 'review', marker: { label: ' ' } }), /marker/);
  assert.throws(() => registerLaunchOption({ id: 'acme.review', label: 'review', marker: { label: 'x'.repeat(33) } }), /marker/);
  assert.throws(() => registerLaunchOption({ id: 'acme.review', label: 'review', banner: { text: '' } }), /banner/);
  assert.throws(() => registerLaunchOption({ id: 'acme.review', label: 'review', banner: { text: 'Read it elsewhere', actionId: 'Not An Id' } }), /banner/);
  assert.deepEqual(listLaunchOptions(), [], 'a refused declaration registers nothing');

  const marker = { label: 'review', hint: 'Reviewed on the board' };
  const banner = { text: 'This session is reviewed on the board.', actionId: 'open-board', actionLabel: 'Open the board' };
  const unregister = registerLaunchOption({ id: 'acme.review', label: 'review', marker, banner });
  try {
    marker.label = 'mutated';
    const [listed] = listLaunchOptions();
    assert.deepEqual(listed.marker, { label: 'review', hint: 'Reviewed on the board' }, 'the registry keeps its own copy');
    assert.deepEqual(listed.banner, banner);
  } finally {
    unregister();
  }
});
