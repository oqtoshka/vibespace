import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { appConfigDb, closeConnection, initializeDatabase, sessionsDb, userDb } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import { parseStoredLaunchOptions, registerLaunchOption } from '@/shared/agent-env.js';

import { nativeControlRoutes } from '../index.js';

/**
 * A federated client switches a declared, switchable launch option on an existing session
 * through the same service as the app's own route: the same refusals, with their status and
 * code kept so the client can say why.
 */

const PROJECT_PATH = '/workspace/native-launch-options';
const TOKEN = 'x'.repeat(40);

async function withRoutes(run: (url: (id: string) => string) => Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(tmpdir(), 'native-launch-options-'));
  closeConnection(); process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  const stop = registerLaunchOption({ id: 'acme.briefing', label: 'briefing', switchable: true });
  const stopFixed = registerLaunchOption({ id: 'acme.fixed', label: 'fixed' });
  const app = express(); app.use(express.json()); app.use('/native', nativeControlRoutes);
  const server = app.listen(0);
  try {
    await initializeDatabase();
    userDb.createUser('operator', 'unused');
    appConfigDb.set('mc_federation_token', TOKEN);
    const port = (server.address() as AddressInfo).port;
    await run(id => `http://127.0.0.1:${port}/native/sessions/${encodeURIComponent(id)}/launch-options`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    stop(); stopFixed();
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

const patch = (url: string, launchOptions: unknown, token = TOKEN, extra: Record<string, string> = {}) => fetch(url, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json', 'x-vibespace-federation-token': token, ...extra },
  body: JSON.stringify({ launchOptions }),
});

test('the federation route switches a switchable option on and off and says when it applies', async () => {
  await withRoutes(async url => {
    const { sessionId } = sessionsService.createAppSession('claude', PROJECT_PATH, false, false, undefined, { 'acme.fixed': true });

    const on = await patch(url(sessionId), { 'acme.briefing': true });
    assert.equal(on.status, 200);
    assert.equal(on.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await on.json(), {
      sessionId, launchOptions: { 'acme.fixed': true, 'acme.briefing': true }, changed: true, appliesAt: 'next-turn',
    });
    assert.deepEqual(parseStoredLaunchOptions(sessionsDb.getSessionById(sessionId)?.launch_options), { 'acme.fixed': true, 'acme.briefing': true });

    const again = await patch(url(sessionId), { 'acme.briefing': true });
    assert.equal(again.status, 200);
    assert.equal(((await again.json()) as { changed: boolean }).changed, false, 'asking for what is there is a success that changes nothing');

    const valued = await patch(url(sessionId), { 'acme.briefing': { needsPlan: true } });
    assert.deepEqual(((await valued.json()) as { launchOptions: unknown }).launchOptions, { 'acme.fixed': true, 'acme.briefing': { needsPlan: true } });

    const off = await patch(url(sessionId), { 'acme.briefing': false });
    assert.equal(off.status, 200);
    assert.deepEqual(((await off.json()) as { launchOptions: unknown }).launchOptions, { 'acme.fixed': true });
  });
});

test('the federation route keeps every refusal with its status and code', async () => {
  await withRoutes(async url => {
    const refusal = async (response: Response) => ({ status: response.status, body: await response.json() as { error: string; code?: string } });

    const missing = await refusal(await patch(url('no-such-session'), { 'acme.briefing': true }));
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'SESSION_NOT_FOUND');

    const { sessionId } = sessionsService.createAppSession('claude', PROJECT_PATH, false, false, undefined, { 'acme.fixed': true });
    const fixed = await refusal(await patch(url(sessionId), { 'acme.fixed': false }));
    assert.equal(fixed.status, 400);
    assert.match(fixed.body.error, /cannot be changed/);
    const malformed = await refusal(await patch(url(sessionId), 'briefing'));
    assert.equal(malformed.status, 400);
    assert.ok(malformed.body.code);

    const side = sessionsService.createAppSession('claude', PROJECT_PATH, true);
    const hidden = sessionsService.createAppSession('claude', PROJECT_PATH, false, true);
    for (const id of [side.sessionId, hidden.sessionId]) {
      const answer = await refusal(await patch(url(id), { 'acme.briefing': true }));
      assert.equal(answer.status, 409);
      assert.equal(answer.body.code, 'LAUNCH_OPTIONS_NOT_SWITCHABLE_HERE');
    }

    const codex = sessionsService.createAppSession('codex', PROJECT_PATH);
    const unsupported = await refusal(await patch(url(codex.sessionId), { 'acme.briefing': true }));
    assert.equal(unsupported.status, 409);
    assert.equal(unsupported.body.code, 'LAUNCH_OPTION_SWITCH_UNSUPPORTED');
    assert.equal(sessionsDb.getSessionById(codex.sessionId)?.launch_options, null);

    const busy = sessionsService.createAppSession('claude', PROJECT_PATH);
    sessionsDb.assignProviderSessionId(busy.sessionId, 'claude-native-route-busy');
    const lease = chatRunRegistry.reserveAdmission({
      appSessionId: busy.sessionId, providerSessionId: 'claude-native-route-busy', resourceId: 'test', generation: '1', ttlMs: 5_000,
    });
    assert.ok(lease);
    try {
      const inFlight = await refusal(await patch(url(busy.sessionId), { 'acme.briefing': true }));
      assert.equal(inFlight.status, 409);
      assert.equal(inFlight.body.code, 'SESSION_TURN_IN_FLIGHT');
      assert.equal(sessionsDb.getSessionById(busy.sessionId)?.launch_options, null);
    } finally {
      lease.release();
    }
  });
});

test('the federation route refuses a wrong token and a browser origin before touching the session', async () => {
  await withRoutes(async url => {
    const { sessionId } = sessionsService.createAppSession('claude', PROJECT_PATH);
    const wrong = await patch(url(sessionId), { 'acme.briefing': true }, 'y'.repeat(40));
    assert.equal(wrong.status, 403);
    const browser = await patch(url(sessionId), { 'acme.briefing': true }, TOKEN, { origin: 'https://example.com' });
    assert.equal(browser.status, 403);
    assert.equal(sessionsDb.getSessionById(sessionId)?.launch_options, null);
  });
});
