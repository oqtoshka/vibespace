import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyOpenCodeFailure } from '../opencode-failure.js';

// Messages as OpenCode 1.18.18 stored them in its event table.
test('a busy or unreachable provider is waited out', () => {
  assert.deepEqual(
    classifyOpenCodeFailure('Provider request failed with HTTP 503: {"error":{"message":"litellm.ServiceUnavailableError: GPU is assigned to another workload"}}'),
    { recoveryKind: 'provider-unavailable', limitType: 'http_503' },
  );
  assert.equal(classifyOpenCodeFailure('Provider request failed with HTTP 502: <html>502 Bad Gateway</html>')?.limitType, 'http_502');
  assert.equal(classifyOpenCodeFailure('HTTP transport failed')?.limitType, 'transport');
  assert.equal(classifyOpenCodeFailure('Failed to read homelab/openai-compatible-chat stream')?.limitType, 'transport');
  assert.deepEqual(
    classifyOpenCodeFailure('Provider request failed with HTTP 429: too many requests'),
    { recoveryKind: 'usage-limit', limitType: 'http_429' },
  );
});

test('failures waiting cannot fix are left alone', () => {
  assert.equal(classifyOpenCodeFailure('Provider request failed with HTTP 429: {"error":{"code":"insufficient_quota"}}'), null);
  assert.equal(classifyOpenCodeFailure('Provider request failed with HTTP 401: invalid api key'), null);
  assert.equal(classifyOpenCodeFailure('Provider request failed with HTTP 400: context length exceeded'), null);
  assert.equal(classifyOpenCodeFailure('OpenAI Chat media must contain valid base64'), null);
  assert.equal(classifyOpenCodeFailure('Provider turn interrupted'), null);
  assert.equal(classifyOpenCodeFailure(undefined), null);
});
