import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {test} from 'node:test';

import express from 'express';

import {createJanitorRouter} from '../janitor.routes.js';
import {Janitor} from '../janitor.service.js';

test('inbox HTTP validates decisions and denies cross-site requests',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'janitor-http-'));
  const service=new Janitor({root:directory,stateFile:path.join(directory,'state.json'),active:()=>false,context:async()=>[],classify:async()=>({proposals:[]}),assertWritable:async()=>{}});
  const app=express();app.use(express.json());app.use('/janitor',createJanitorRouter(service));app.use('/disabled',createJanitorRouter(null));
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}`;
  try{
    assert.deepEqual(await(await fetch(base+'/disabled')).json(),{enabled:false});
    const post=(route:string,body:unknown,headers={})=>fetch(base+'/janitor/'+route,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
    assert.equal((await post('trash',{ids:[]})).status,400);
    assert.equal((await post('trash',{ids:[12]})).status,400);
    assert.equal((await post('trash',{ids:Array(51).fill('id')})).status,400);
    assert.equal((await post('trash',{ids:['x']},{'Sec-Fetch-Site':'cross-site'})).status,403);
    const result=await(await post('trash',{ids:['missing']})).json() as {results:Array<{ok:boolean}>};assert.equal(result.results[0].ok,false);
    assert.equal((await post('preferences',{nightlyEnabled:false})).status,200);
    assert.equal((await service.status()).nightlyEnabled,false);
    assert.equal((await fetch(base+'/janitor/preview/missing')).status,404);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(directory,{recursive:true,force:true});}
});
