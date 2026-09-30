import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import { FdObserver, type FdProbeExec } from '@/modules/fd-observation/index.js';
import { createFdObservationRouter } from '@/modules/fd-observation/fd-observation.routes.js';

test('GET /fd serves the ring; ?fresh=1 records a sample first', async () => {
  const exec: FdProbeExec = async (file) => {
    if (file === 'lsof') return { stdout: 'f1\ntPIPE\nf2\ntunix\n' };
    throw Object.assign(new Error('no match'), { code: 1 });
  };
  const observer = new FdObserver({ platform: 'darwin', exec, ringSize: 5 });
  const app = express();
  app.use('/api/diagnostics', createFdObservationRouter(observer));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/diagnostics/fd`;
  try {
    const empty = (await (await fetch(base)).json()) as any;
    assert.equal(empty.samples.length, 0);
    assert.equal(empty.ringSize, 5);

    const fresh = (await (await fetch(`${base}?fresh=1`)).json()) as any;
    assert.equal(fresh.samples.length, 1);
    assert.deepEqual(fresh.samples[0].byType, { PIPE: 1, unix: 1 });
    assert.deepEqual(fresh.samples[0].children, { ok: true, count: 0, pids: [], truncated: false });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
