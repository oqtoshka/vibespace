import assert from 'node:assert/strict';
import test from 'node:test';

const { mapPermissionModeToCodexOptions } = await import('./openai-codex.js');

// A side question only reads (Mission Control FEAT-SESSION-030). Codex has no
// plan mode, so the read-only sandbox is the guarantee — and the operator's
// sandbox override must not widen it.
test('a side question runs Codex in the read-only sandbox whatever the mode or override', () => {
  const previous = process.env.VS_CODEX_SANDBOX;
  process.env.VS_CODEX_SANDBOX = 'danger-full-access';
  try {
    for (const mode of ['plan', 'default', 'bypassPermissions', 'acceptEdits']) {
      assert.deepEqual(mapPermissionModeToCodexOptions(mode, { readOnly: true }), { sandboxMode: 'read-only', approvalPolicy: 'never' });
    }
    assert.equal(mapPermissionModeToCodexOptions('default').sandboxMode, 'danger-full-access');
  } finally {
    if (previous === undefined) delete process.env.VS_CODEX_SANDBOX; else process.env.VS_CODEX_SANDBOX = previous;
  }
});
