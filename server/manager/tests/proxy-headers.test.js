import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildProxyHeaders } from '../proxy.js';

const baseOptions = {
  username: 'main',
  workerToken: 'secret-token',
  remoteAddress: '10.0.0.5',
  proto: 'https',
  upstreamHost: '172.28.0.201:7100',
};

describe('buildProxyHeaders', () => {
  it('stamps the authenticated identity and worker token', () => {
    const headers = buildProxyHeaders({ host: 'vs.oqto.app' }, baseOptions);

    assert.equal(headers['x-vibespace-user'], 'main');
    assert.equal(headers['x-vibespace-worker-token'], 'secret-token');
  });

  it('drops a client-supplied identity header instead of forwarding it', () => {
    const headers = buildProxyHeaders(
      { 'x-vibespace-user': 'sanyaz', 'x-vibespace-worker-token': 'stolen' },
      baseOptions
    );

    assert.equal(headers['x-vibespace-user'], 'main');
    assert.equal(headers['x-vibespace-worker-token'], 'secret-token');
    assert.equal(
      Object.keys(headers).filter((name) => name.toLowerCase() === 'x-vibespace-user').length,
      1
    );
  });

  it('omits the worker token when the link has none', () => {
    const headers = buildProxyHeaders({}, { ...baseOptions, workerToken: null });

    assert.equal(headers['x-vibespace-worker-token'], undefined);
  });

  it('rewrites Host to the upstream and preserves the original', () => {
    const headers = buildProxyHeaders({ host: 'vs.oqto.app' }, baseOptions);

    assert.equal(headers.host, '172.28.0.201:7100');
    assert.equal(headers['x-forwarded-host'], 'vs.oqto.app');
  });

  it('appends to an existing x-forwarded-for chain', () => {
    const headers = buildProxyHeaders({ 'x-forwarded-for': '203.0.113.9' }, baseOptions);

    assert.equal(headers['x-forwarded-for'], '203.0.113.9, 10.0.0.5');
  });

  it('starts an x-forwarded-for chain when there is none', () => {
    const headers = buildProxyHeaders({}, baseOptions);

    assert.equal(headers['x-forwarded-for'], '10.0.0.5');
  });

  it('honours an inbound x-forwarded-proto over the socket protocol', () => {
    const headers = buildProxyHeaders({ 'x-forwarded-proto': 'https' }, { ...baseOptions, proto: 'http' });

    assert.equal(headers['x-forwarded-proto'], 'https');
  });

  it('strips hop-by-hop headers on a normal request', () => {
    const headers = buildProxyHeaders(
      { connection: 'keep-alive', upgrade: 'h2c', 'transfer-encoding': 'chunked', 'x-real-ip': '1.2.3.4' },
      baseOptions
    );

    assert.equal(headers.connection, undefined);
    assert.equal(headers.upgrade, undefined);
    assert.equal(headers['transfer-encoding'], undefined);
    assert.equal(headers['x-real-ip'], '1.2.3.4');
  });

  it('keeps the handshake headers on an upgrade', () => {
    const headers = buildProxyHeaders(
      {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': 'abc123',
        'sec-websocket-version': '13',
      },
      { ...baseOptions, upgrade: true }
    );

    assert.equal(headers.connection, 'Upgrade');
    assert.equal(headers.upgrade, 'websocket');
    assert.equal(headers['sec-websocket-key'], 'abc123');
    assert.equal(headers['sec-websocket-version'], '13');
  });
});
