import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import http from 'node:http';

import { createShareOwnerIndex, shareIdFromPath } from '../share-owners.js';
import { WORKER_TOKEN_HEADER, WORKER_USER_HEADER } from '../../constants/config.js';

const linksFor = (...userIds) =>
  new Map(
    userIds.map((userId, i) => [
      userId,
      {
        user_id: userId,
        upstream: `http://127.0.0.1:${7100 + i}`,
        workerToken: `token-${userId}`,
        enabled: true,
      },
    ])
  );

describe('shareIdFromPath', () => {
  it('extracts the id from every share subroute', () => {
    assert.equal(shareIdFromPath('/api/share/abc123/meta'), 'abc123');
    assert.equal(shareIdFromPath('/api/share/abc123/content'), 'abc123');
    assert.equal(shareIdFromPath('/api/share/abc123/preview/kit/app.css'), 'abc123');
    assert.equal(shareIdFromPath('/api/share/abc123'), 'abc123');
  });

  it('ignores paths that are not share links', () => {
    assert.equal(shareIdFromPath('/api/projects/p1/share'), null);
    assert.equal(shareIdFromPath('/api/debug-log'), null);
    assert.equal(shareIdFromPath('/share/abc123'), null);
  });
});

describe('createShareOwnerIndex', () => {
  it('routes a share to whichever worker claims it, not the caller', async () => {
    const index = createShareOwnerIndex({
      links: linksFor('main', 'sanyaz', 'sanyaal'),
      probe: async (address) => ({ owns: address.userId === 'sanyaal', answered: true }),
    });

    assert.deepEqual(await index.findOwner('shared-by-sanyaal'), {
      userId: 'sanyaal',
      conclusive: true,
    });
  });

  it('treats a valid link to a deleted file as owned, so the 410 comes from the right worker', async () => {
    // `owns` is what probeWorker derives from a 410 as well as a 200.
    const index = createShareOwnerIndex({
      links: linksFor('main', 'sanyaal'),
      probe: async (address) => ({ owns: address.userId === 'sanyaal', answered: true }),
    });

    assert.equal((await index.findOwner('file-since-deleted')).userId, 'sanyaal');
  });

  it('caches the owner so subsequent subresource requests skip the fan-out', async () => {
    let probes = 0;
    const index = createShareOwnerIndex({
      links: linksFor('main', 'sanyaal'),
      probe: async (address) => {
        probes += 1;
        return { owns: address.userId === 'sanyaal', answered: true };
      },
    });

    await index.findOwner('cached');
    await index.findOwner('cached');
    await index.findOwner('cached');

    assert.equal(probes, 2, 'one round of probes, then cache hits');
    assert.equal(index.size(), 1);
  });

  it('re-probes after the owner is forgotten', async () => {
    let probes = 0;
    const index = createShareOwnerIndex({
      links: linksFor('sanyaal'),
      probe: async () => {
        probes += 1;
        return { owns: true, answered: true };
      },
    });

    await index.findOwner('x');
    index.forget('x');
    await index.findOwner('x');

    assert.equal(probes, 2);
  });

  it('calls an unclaimed share conclusive only when every worker answered', async () => {
    const index = createShareOwnerIndex({
      links: linksFor('main', 'sanyaal'),
      probe: async () => ({ owns: false, answered: true }),
    });

    assert.deepEqual(await index.findOwner('never-existed'), { userId: null, conclusive: true });
  });

  it('refuses to call a share dead while its owner is too busy to answer', async () => {
    // The case that broke in production: sanyaal's worker was mid-agent-turn
    // and missed the probe, and reporting that as "invalid or expired" brands a
    // live link dead.
    const index = createShareOwnerIndex({
      links: linksFor('main', 'sanyaal'),
      probe: async (address) =>
        address.userId === 'sanyaal'
          ? { owns: false, answered: false }
          : { owns: false, answered: true },
    });

    assert.deepEqual(await index.findOwner('owned-by-a-busy-worker'), {
      userId: null,
      conclusive: false,
    });
  });

  it('does not cache an inconclusive miss', async () => {
    let answered = false;
    const index = createShareOwnerIndex({
      links: linksFor('sanyaal'),
      // Busy on the first pass, claims the share on the second.
      probe: async () => {
        const result = { owns: answered, answered };
        answered = true;
        return result;
      },
    });

    assert.equal((await index.findOwner('id')).conclusive, false);
    assert.equal(index.size(), 0);
    assert.equal((await index.findOwner('id')).userId, 'sanyaal');
  });

  it('skips disabled workers', async () => {
    const links = linksFor('main', 'sanyaal');
    links.get('sanyaal').enabled = false;
    const asked = [];
    const index = createShareOwnerIndex({
      links,
      probe: async (address) => {
        asked.push(address.userId);
        return { owns: false, answered: true };
      },
    });

    await index.findOwner('id');
    assert.deepEqual(asked, ['main']);
  });
});

describe('the default HTTP probe', () => {
  let server;
  let port;
  const requests = [];

  before(async () => {
    server = http.createServer((req, res) => {
      requests.push({ url: req.url, headers: req.headers });
      const id = req.url.split('/')[3];
      const status = id === 'owned' ? 200 : id === 'gone' ? 410 : 404;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  after(() => server.close());

  const indexAgainstServer = () =>
    createShareOwnerIndex({
      links: new Map([
        ['sanyaal', { user_id: 'sanyaal', upstream: `http://127.0.0.1:${port}`, workerToken: 'wt', enabled: true }],
      ]),
    });

  it('claims a 200 and stamps the worker identity headers', async () => {
    const { userId } = await indexAgainstServer().findOwner('owned');

    assert.equal(userId, 'sanyaal');
    const last = requests.at(-1);
    assert.equal(last.url, '/api/share/owned/meta');
    assert.equal(last.headers[WORKER_USER_HEADER], 'sanyaal');
    assert.equal(last.headers[WORKER_TOKEN_HEADER], 'wt');
  });

  it('claims a 410 — the link is real, the file is not', async () => {
    assert.equal((await indexAgainstServer().findOwner('gone')).userId, 'sanyaal');
  });

  it('does not claim a 404, and that answer is conclusive', async () => {
    assert.deepEqual(await indexAgainstServer().findOwner('someone-elses'), {
      userId: null,
      conclusive: true,
    });
  });

  it('reports a silent worker as inconclusive rather than as a missing share', async () => {
    const index = createShareOwnerIndex({
      links: new Map([
        ['dead', { user_id: 'dead', upstream: 'http://127.0.0.1:1', workerToken: 'wt', enabled: true }],
      ]),
    });

    assert.deepEqual(await index.findOwner('id'), { userId: null, conclusive: false });
  });
});
