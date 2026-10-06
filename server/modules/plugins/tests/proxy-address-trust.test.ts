import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

// Production resolves the exact lock dependency. Independent review may supply a
// separately installed patched dependency without mutating the shared node_modules.
const require = createRequire(import.meta.url);
const proxyaddr = require(process.env.PROXY_ADDR_TEST_MODULE || 'proxy-addr');

test('IPv4-mapped IPv6 short prefix does not trust an arbitrary IPv4 peer (GHSA-jqcg-44mw-7w3h)', () => {
  const trust = proxyaddr.compile('::ffff:10.0.0.0/8');
  assert.equal(trust('203.0.113.10', 0), false);
  const request = { headers: { 'x-forwarded-for': '198.51.100.77' }, connection: { remoteAddress: '203.0.113.10' } };
  assert.equal(proxyaddr(request, trust), '203.0.113.10');
});

test('Correct IPv4 and full mapped trust prefixes retain legitimate proxy behavior', () => {
  for (const subnet of ['10.0.0.0/8', '::ffff:10.0.0.0/104']) {
    const trust = proxyaddr.compile(subnet);
    assert.equal(trust('10.1.2.3', 0), true);
    assert.equal(trust('203.0.113.10', 0), false);
    assert.equal(proxyaddr({ headers: { 'x-forwarded-for': '198.51.100.77' }, connection: { remoteAddress: '10.1.2.3' } }, trust), '198.51.100.77');
  }
});
