import assert from 'node:assert/strict';
import test from 'node:test';

import { toCodexAppServerSandboxPolicy } from './codex-sandbox-policy.js';

test('maps VibeSpace permission sandboxes to Codex turn/start policies', () => {
  assert.deepEqual(toCodexAppServerSandboxPolicy('danger-full-access'), {
    type: 'dangerFullAccess',
  });
  assert.deepEqual(toCodexAppServerSandboxPolicy('workspace-write'), {
    type: 'workspaceWrite',
  });
  assert.deepEqual(toCodexAppServerSandboxPolicy('read-only'), {
    type: 'readOnly',
  });
});

test('rejects an unknown sandbox instead of silently weakening it', () => {
  assert.throws(
    () => toCodexAppServerSandboxPolicy('mystery'),
    /Unsupported Codex sandbox mode/,
  );
});
