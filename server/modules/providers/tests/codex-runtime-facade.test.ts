import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import * as facade from '../list/codex/codex-runtime.provider.js';
// eslint-disable-next-line boundaries/no-unknown -- Verify identity against the unchanged legacy runtime, without invoking it.
import * as implementation from '../../../openai-codex.js';
import { providerRegistry } from '../provider.registry.js';
// eslint-disable-next-line boundaries/no-unknown -- Compare the cached-only legacy transport lookup without spawning a provider.
import { getExistingCodexAppServerTransports } from '../../../services/codex-app-server.service.js';

test('typed Codex facade preserves legacy export identity and cached-only transport lookup', () => {
  for (const name of ['queryCodex', 'injectCodexMessage', 'abortCodexSession',
    'isCodexSessionActive', 'getActiveCodexSessions', 'isCodexUsageLimitError',
    'pickCodexLimitReset', '__resetCodexRateLimits'] as const) {
    assert.equal(facade[name], implementation[name]);
  }
  assert.equal(providerRegistry.listProviders().find(provider => provider.id === 'codex')?.runtime, facade.codexRuntime);
  assert.deepEqual(facade.existingCodexTransports(), getExistingCodexAppServerTransports());
  assert.throws(() => facade.codexRuntime(), /runtime adapter object/);
});

test('typed facade retains hoisted registry cycle for either module entry order', () => {
  for (const entry of ['./server/modules/providers/provider.registry.ts',
    './server/modules/providers/list/codex/codex-runtime.provider.ts']) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      await import(${JSON.stringify(entry)});
      const { providerRegistry } = await import('./server/modules/providers/provider.registry.ts');
      const { codexRuntime } = await import('./server/modules/providers/list/codex/codex-runtime.provider.ts');
      const runtime = providerRegistry.listProviders().find(p => p.id === 'codex').runtime;
      if (runtime !== codexRuntime || typeof runtime.run !== 'function' || typeof runtime.abort !== 'function') process.exit(1);
    `], { cwd: process.cwd(), env: { ...process.env, TSX_TSCONFIG_PATH: 'server/tsconfig.json' }, timeout: 15000, encoding: 'utf8' });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
  }
});
