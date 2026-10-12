import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { appConfigDb, closeConnection, initializeDatabase, sessionsDb, userDb } from '@/modules/database/index.js';
import { nativeWorkspaceRoutes } from '../native-workspace.routes.js';

test('workspace routes require federation, reject browser origins and private/side sessions', async () => {
  const previous = process.env.DATABASE_PATH;
  const root = await mkdtemp(path.join(os.tmpdir(), 'workspace-route-'));
  closeConnection(); process.env.DATABASE_PATH = path.join(root,'auth.db');
  const app = express(); app.use(express.json()); app.use('/workspace',nativeWorkspaceRoutes);
  const server = app.listen(0,'127.0.0.1');
  await new Promise<void>(resolve=>server.once('listening',resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/workspace/sessions/`;
  const token = 't'.repeat(40);
  try {
    await initializeDatabase(); userDb.createUser('operator','unused'); appConfigDb.set('mc_federation_token',token);
    sessionsDb.createAppSession('ordinary','codex',root);
    sessionsDb.createAppSession('private','codex',root,false,true);
    sessionsDb.createAppSession('side','codex',root,true,false);
    await writeFile(path.join(root,'readme.md'),'real authorized bytes');
    const request = (id: string,headers: Record<string,string>={})=>fetch(base+id,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify({op:'read',path:'readme.md'})});
    assert.equal((await request('ordinary')).status,403);
    assert.equal((await request('ordinary',{'x-mc-federation-token':'wrong'})).status,403);
    assert.equal((await request('ordinary',{'x-mc-federation-token':token,origin:'https://project.invalid'})).status,403);
    for(const id of ['private','side','missing']) assert.equal((await request(id,{'x-mc-federation-token':token})).status,400);
    const response=await request('ordinary',{'x-mc-federation-token':token});assert.equal(response.status,200);
    assert.equal(Buffer.from(((await response.json()) as {base64:string}).base64,'base64').toString(),'real authorized bytes');
  } finally {
    await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())); closeConnection();
    if(previous===undefined)delete process.env.DATABASE_PATH;else process.env.DATABASE_PATH=previous;
    await rm(root,{recursive:true,force:true});
  }
});

test('raw route streams bytes with the file type, Range 206/416 and the same federation rules', async () => {
  const previous = process.env.DATABASE_PATH;
  const root = await mkdtemp(path.join(os.tmpdir(), 'workspace-raw-'));
  closeConnection(); process.env.DATABASE_PATH = path.join(root,'auth.db');
  const app = express(); app.use(express.json()); app.use('/workspace',nativeWorkspaceRoutes);
  const server = app.listen(0,'127.0.0.1');
  await new Promise<void>(resolve=>server.once('listening',resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/workspace/sessions/`;
  const token = 't'.repeat(40);
  try {
    await initializeDatabase(); userDb.createUser('operator','unused'); appConfigDb.set('mc_federation_token',token);
    sessionsDb.createAppSession('ordinary','codex',root);
    sessionsDb.createAppSession('private','codex',root,false,true);
    const bytes = Buffer.alloc(40 * 1024 * 1024, 7); bytes.write('ftypisom', 4);
    await writeFile(path.join(root,'clip.mp4'), bytes);
    const raw = async (id: string, file: string, headers: Record<string,string> = {}) => {
      const response = await fetch(base + id + '/raw?path=' + encodeURIComponent(file), { headers: { 'x-mc-federation-token': token, ...headers } });
      return { status: response.status, headers: response.headers, body: Buffer.from(await response.arrayBuffer()) };
    };
    assert.equal((await raw('ordinary', 'clip.mp4', { 'x-mc-federation-token': 'wrong' })).status, 403);
    assert.equal((await raw('ordinary', 'clip.mp4', { origin: 'https://project.invalid' })).status, 403);
    assert.equal((await raw('private', 'clip.mp4')).status, 400);
    const outside = await raw('ordinary', '/etc/hosts');
    assert.equal(outside.status, 400); assert.equal(outside.headers.get('x-native-workspace-raw'), '1');
    const missing = await raw('ordinary', 'gone.mp4');
    assert.equal(missing.status, 404); assert.equal(missing.headers.get('x-native-workspace-raw'), '1');

    // Larger than the 32 MiB read cap: the raw route has none.
    const full = await raw('ordinary', 'clip.mp4');
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('content-type'), 'video/mp4');
    assert.equal(full.headers.get('accept-ranges'), 'bytes');
    assert.equal(full.headers.get('content-length'), String(bytes.length));
    assert.equal(full.headers.get('x-native-workspace-raw'), '1');
    assert.equal(full.body.length, bytes.length);

    const part = await raw('ordinary', 'clip.mp4', { range: 'bytes=4-11' });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), `bytes 4-11/${bytes.length}`);
    assert.equal(part.body.toString(), 'ftypisom');

    const beyond = await raw('ordinary', 'clip.mp4', { range: `bytes=${bytes.length + 10}-` });
    assert.equal(beyond.status, 416);
    assert.equal(beyond.headers.get('content-range'), `bytes */${bytes.length}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())); closeConnection();
    if(previous===undefined)delete process.env.DATABASE_PATH;else process.env.DATABASE_PATH=previous;
    await rm(root,{recursive:true,force:true});
  }
});
