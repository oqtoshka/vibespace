import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { probeOpenAIContextWindow, resolveApiKey } from '@/shared/openai-context-probe.js';

type Routes = Record<string, unknown>;

/**
 * A throwaway OpenAI-compatible server. Records what it was asked for, so the
 * tests can assert on the *shape* of the probe — how many hops it takes and
 * whether it stops early — not just its answer.
 */
async function withServer(
  routes: Routes,
  run: (baseURL: string, seen: string[]) => Promise<void>,
): Promise<void> {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    const path = req.url ?? '';
    seen.push(path);
    const body = routes[path];
    if (body === undefined) {
      res.writeHead(404).end('{}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };

  try {
    await run(`http://127.0.0.1:${port}/v1`, seen);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const vllmModels = (id: string, maxModelLen: number) => ({
  object: 'list',
  data: [{ id, object: 'model', owned_by: 'vllm', max_model_len: maxModelLen }],
});

test('vLLM\'s own max_model_len is the answer when the engine is reachable', async () => {
  await withServer({ '/v1/models': vllmModels('local', 139_264) }, async (baseURL, seen) => {
    const probed = await probeOpenAIContextWindow({ baseURL, modelKey: 'local' });
    assert.equal(probed?.context, 139_264);
    // One hop. The model list answered, so /model/info is never asked.
    assert.deepEqual(seen, ['/v1/models']);
  });
});

test('a proxy that republishes a limit is believed without a second hop', async () => {
  const routes = {
    '/v1/models': {
      data: [{ id: 'gpt-4o-mini', mode: 'chat', max_input_tokens: 128_000, max_output_tokens: 16_384 }],
    },
  };
  await withServer(routes, async (baseURL, seen) => {
    const probed = await probeOpenAIContextWindow({ baseURL, modelKey: 'gpt-4o-mini' });
    assert.equal(probed?.context, 128_000);
    assert.deepEqual(seen, ['/v1/models']);
  });
});

test('a LiteLLM proxy is followed back to the engine holding the model', async () => {
  // This is the case that made the gauge wrong: LiteLLM lists a self-hosted
  // model with no limits at all, because it is not in LiteLLM's cost catalog.
  await withServer({ '/v1/models': vllmModels('local', 139_264) }, async (engineURL) => {
    const proxyRoutes = {
      '/v1/models': { data: [{ id: 'local', object: 'model', owned_by: 'openai' }] },
      '/v1/model/info': {
        data: [{
          model_name: 'local',
          litellm_params: { model: 'openai/local', api_base: engineURL },
          model_info: { key: 'openai/local', max_input_tokens: null, max_output_tokens: null },
        }],
      },
    };

    await withServer(proxyRoutes, async (proxyURL, seen) => {
      const probed = await probeOpenAIContextWindow({ baseURL: proxyURL, modelKey: 'local' });
      assert.equal(probed?.context, 139_264);
      assert.deepEqual(seen, ['/v1/models', '/v1/model/info']);
    });
  });
});

test('a LiteLLM entry that declares its own ceiling stops there', async () => {
  const routes = {
    '/v1/models': { data: [{ id: 'local', object: 'model' }] },
    '/v1/model/info': {
      data: [{
        model_name: 'local',
        litellm_params: { model: 'openai/local', api_base: 'http://127.0.0.1:1/v1' },
        model_info: { max_input_tokens: 200_000 },
      }],
    },
  };
  // The api_base is a closed port: if the declared ceiling were not preferred
  // this would hang for a probe timeout and then fail.
  await withServer(routes, async (baseURL) => {
    const probed = await probeOpenAIContextWindow({ baseURL, modelKey: 'local' });
    assert.equal(probed?.context, 200_000);
  });
});

test('a server with nothing to say yields null rather than a guess', async () => {
  const routes = { '/v1/models': { data: [{ id: 'local', object: 'model' }] } };
  await withServer(routes, async (baseURL) => {
    assert.equal(await probeOpenAIContextWindow({ baseURL, modelKey: 'local' }), null);
  });
});

test('a model the server does not list is not answered from another model\'s limits', async () => {
  await withServer({ '/v1/models': vllmModels('other', 139_264) }, async (baseURL) => {
    assert.equal(await probeOpenAIContextWindow({ baseURL, modelKey: 'local' }), null);
  });
});

test('an unreachable endpoint fails quietly', async () => {
  assert.equal(
    await probeOpenAIContextWindow({ baseURL: 'http://127.0.0.1:1/v1', modelKey: 'local' }),
    null,
  );
  // Not a URL at all, and a bare hostname: neither is worth a request.
  assert.equal(await probeOpenAIContextWindow({ baseURL: 'llm.example', modelKey: 'local' }), null);
  assert.equal(await probeOpenAIContextWindow({ baseURL: '', modelKey: 'local' }), null);
});

test('llama.cpp\'s trained length is not mistaken for the served window', async () => {
  // n_ctx_train is what the weights were trained at; a server started with a
  // smaller -c would refuse a request sized against it.
  const routes = {
    '/v1/models': { data: [{ id: 'local', meta: { n_ctx_train: 131_072, n_ctx: 8_192 } }] },
  };
  await withServer(routes, async (baseURL) => {
    assert.equal(await probeOpenAIContextWindow({ baseURL, modelKey: 'local' }), null);
  });
});

test('the api key travels as a bearer token, including through {env:VAR}', async () => {
  process.env.PROBE_TEST_KEY = 'sk-from-env';
  try {
    assert.equal(resolveApiKey('{env:PROBE_TEST_KEY}'), 'sk-from-env');
    assert.equal(resolveApiKey('{env:PROBE_TEST_MISSING}'), null);
    assert.equal(resolveApiKey('sk-literal'), 'sk-literal');
    assert.equal(resolveApiKey(''), null);
    assert.equal(resolveApiKey(undefined), null);
  } finally {
    delete process.env.PROBE_TEST_KEY;
  }

  const authorized: Array<string | undefined> = [];
  const server = http.createServer((req, res) => {
    authorized.push(req.headers.authorization);
    res.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify(vllmModels('local', 40_960)));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };

  try {
    const probed = await probeOpenAIContextWindow({
      baseURL: `http://127.0.0.1:${port}/v1`,
      modelKey: 'local',
      apiKey: 'sk-secret',
    });
    assert.equal(probed?.context, 40_960);
    assert.deepEqual(authorized, ['Bearer sk-secret']);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
