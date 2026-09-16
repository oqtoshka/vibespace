import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { once } from 'node:events';

import express from 'express';

import { createWorkspacePolicyAdminRouter } from '../workspace-policy-admin.routes.js';

test('manager policy API denies ordinary users, cross-origin writes and stale forms', async () => {
  const directory=await mkdtemp(path.join(os.tmpdir(),'policy-http-'));
  const filename=path.join(directory,'policy.json');
  await writeFile(filename,JSON.stringify({version:1,root:directory,rules:[]}));
  const app=express();
  app.use(express.json());
  // Test boundary substitutes the manager's already verified identity.
  app.use((request,response,next)=>{response.locals.workspaceUser=request.get('X-Test-User');next();});
  app.use('/policy',createWorkspacePolicyAdminRouter(filename,['admin'],'https://workspace.example'));
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  const address=server.address();assert.ok(address && typeof address!=='string');
  const url=`http://127.0.0.1:${address.port}/policy`;
  try {
    assert.equal((await fetch(url,{headers:{'X-Test-User':'ordinary'}})).status,403);
    const snapshot=await (await fetch(url,{headers:{'X-Test-User':'admin'}})).json() as {revision:string};
    const headers={'X-Test-User':'admin','Content-Type':'application/json'};
    const body=JSON.stringify({rules:[{path:'managed',readOnly:true}],revision:snapshot.revision});
    assert.equal((await fetch(url,{method:'PUT',headers:{...headers,Origin:'https://other.example'},body})).status,403);
    assert.equal((await fetch(url,{method:'PUT',headers:{...headers,'Sec-Fetch-Site':'cross-site'},body})).status,403);
    assert.equal((await fetch(url,{method:'PUT',headers:{...headers,Origin:'https://workspace.example'},body})).status,200);
    assert.equal((await fetch(url,{method:'PUT',headers,body})).status,409);
    assert.equal((await fetch(url,{method:'PUT',headers:{...headers,'X-Test-User':'ordinary'},body})).status,403);
  } finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(directory,{recursive:true,force:true});}
});
