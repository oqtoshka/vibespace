import assert from 'node:assert/strict';
import test from 'node:test';

import { verifyWebSocketClient } from '@/modules/websocket/services/websocket-auth.service.js';
import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';

type VerifyInfo = Parameters<typeof verifyWebSocketClient>[0];

function makeInfo(headers: Record<string, string> = {}, url = '/ws'): VerifyInfo {
  const request = { url, headers, socket: { remoteAddress: '127.0.0.1' } } as unknown as AuthenticatedWebSocketRequest;
  return { req: request, origin: '', secure: false } as unknown as VerifyInfo;
}

const WORKER_USER = { id: 1, userId: 1, username: 'main' };

test('worker mode authenticates from the manager-stamped header', () => {
  const info = makeInfo({ 'x-vibespace-user': 'main' });

  const accepted = verifyWebSocketClient(info, {
    isPlatform: false,
    isWorkerMode: true,
    authenticateWebSocket: () => null,
    resolveWorkerUser: () => WORKER_USER,
  });

  assert.equal(accepted, true);
  assert.deepEqual((info.req as AuthenticatedWebSocketRequest).user, WORKER_USER);
});

test('worker mode leaves the user unset when the identity is untrusted', () => {
  const info = makeInfo({});

  // The handshake is still accepted: the connection handler closes with an
  // app-level code the client can act on, rather than an opaque socket error.
  const accepted = verifyWebSocketClient(info, {
    isPlatform: false,
    isWorkerMode: true,
    authenticateWebSocket: () => null,
    resolveWorkerUser: () => null,
  });

  assert.equal(accepted, true);
  assert.equal((info.req as AuthenticatedWebSocketRequest).user, undefined);
});

test('worker mode ignores a query token', () => {
  const info = makeInfo({}, '/ws?token=some-manager-jwt');
  let tokenAuthCalled = false;

  verifyWebSocketClient(info, {
    isPlatform: false,
    isWorkerMode: true,
    authenticateWebSocket: () => {
      tokenAuthCalled = true;
      return WORKER_USER;
    },
    resolveWorkerUser: () => null,
  });

  assert.equal(tokenAuthCalled, false);
  assert.equal((info.req as AuthenticatedWebSocketRequest).user, undefined);
});

test('local mode still authenticates from the query token', () => {
  const info = makeInfo({}, '/ws?token=valid');

  const accepted = verifyWebSocketClient(info, {
    isPlatform: false,
    isWorkerMode: false,
    authenticateWebSocket: (token) => (token === 'valid' ? WORKER_USER : null),
  });

  assert.equal(accepted, true);
  assert.deepEqual((info.req as AuthenticatedWebSocketRequest).user, WORKER_USER);
});

test('local mode is unaffected by an identity header', () => {
  const info = makeInfo({ 'x-vibespace-user': 'sanyaz' });

  verifyWebSocketClient(info, {
    isPlatform: false,
    isWorkerMode: false,
    authenticateWebSocket: () => null,
  });

  assert.equal((info.req as AuthenticatedWebSocketRequest).user, undefined);
});
