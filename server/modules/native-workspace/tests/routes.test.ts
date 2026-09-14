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
