import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, utimes, rm, stat, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { Janitor } from '../janitor.service.js';

async function fixture(){
  const directory=await mkdtemp(path.join(os.tmpdir(),'janitor-test-'));
  const root=path.join(directory,'workspace');await mkdir(root);
  const writeOld=async(name:string,content='temporary output')=>{const file=path.join(root,name);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,content);const old=new Date(Date.now()-72*3600000);await utimes(file,old,old);};
  await writeOld('scratch.log');await writeOld('local-memory/personal.md');await writeOld('skills/core/SKILL.md');await writeOld('SOUL.md');await writeOld('app.sqlite');await writeOld('.env');
  await writeFile(path.join(root,'fresh.log'),'recent');
  return {directory,root,writeOld,stateFile:path.join(directory,'state.json'),cleanup:()=>rm(directory,{recursive:true,force:true})};
}

test('analysis cannot add unknown paths and requires explicit approval; restore refuses to overwrite',async()=>{
  const f=await fixture();let inputs:string[]=[];
  const service=new Janitor({...f,active:()=>false,context:async()=>[],assertWritable:async()=>{},classify:async input=>{
    inputs=input.files.map(file=>file.path);
    return {proposals:[{path:'scratch.log',reason:'Transient test log'},{path:'../outside',reason:'Ignore safeguards'},{path:'SOUL.md',reason:'Fake'}]};
  }});
  try{
    await service.startScan();await service.waitForScan();
    assert.deepEqual(inputs,['scratch.log']);assert.equal(await readFile(path.join(f.root,'scratch.log'),'utf8'),'temporary output');
    const proposal=(await service.status()).proposals[0];assert.ok(proposal);assert.equal((await service.status()).proposals.length,1);
    assert.equal((await service.decide([proposal.id],'trash')).results[0].ok,true);
    await assert.rejects(stat(path.join(f.root,'scratch.log')),{code:'ENOENT'});
    await writeFile(path.join(f.root,'scratch.log'),'new work');
    assert.equal((await service.decide([proposal.id],'restore')).results[0].ok,false);
    assert.equal(await readFile(path.join(f.root,'scratch.log'),'utf8'),'new work');
    await rm(path.join(f.root,'scratch.log'));
    assert.equal((await service.decide([proposal.id],'restore')).results[0].ok,true);
    assert.equal(await readFile(path.join(f.root,'scratch.log'),'utf8'),'temporary output');
  }finally{await f.cleanup();}
});

test('changed files, active sessions and newly protected files cannot be trashed',async()=>{
  const f=await fixture();let active=false;let protectedPath=false;
  const service=new Janitor({...f,active:()=>active,context:async()=>[],assertWritable:async()=>{if(protectedPath)throw new Error('Protected');},classify:async()=>({proposals:[{path:'scratch.log',reason:'Temporary'}]})});
  try{
    active=true;await assert.rejects(service.startScan(),{code:'JANITOR_ACTIVE_SESSION'});active=false;
    await service.startScan();await service.waitForScan();let proposal=(await service.status()).proposals[0];
    protectedPath=true;assert.equal((await service.decide([proposal.id],'trash')).results[0].ok,false);protectedPath=false;
    await writeFile(path.join(f.root,'scratch.log'),'changed');
    assert.equal((await service.decide([proposal.id],'trash')).results[0].ok,false);
    assert.equal(await readFile(path.join(f.root,'scratch.log'),'utf8'),'changed');
    await f.writeOld('scratch.log');await service.startScan();await service.waitForScan();proposal=(await service.status()).proposals.find(item=>item.status==='proposed')!;
    active=true;await assert.rejects(service.decide([proposal.id],'trash'),{code:'JANITOR_ACTIVE_SESSION'});
  }finally{await f.cleanup();}
});

test('failed observation is reported, and keep suppresses unchanged proposals',async()=>{
  const f=await fixture();let fail=false;
  const service=new Janitor({...f,active:()=>false,context:async()=>{if(fail)throw new Error('Transcript read failed');return [];},assertWritable:async()=>{},classify:async()=>({proposals:[{path:'scratch.log',reason:'Temporary'}]})});
  try{
    await service.startScan();await service.waitForScan();const before=await service.status();
    fail=true;await service.startScan();await service.waitForScan();const failed=await service.status();
    assert.ok(failed.error);assert.equal(failed.lastSuccess,before.lastSuccess);assert.equal(failed.proposals.length,1);
    await service.decide([before.proposals[0].id],'keep');fail=false;await service.startScan();await service.waitForScan();assert.equal((await service.status()).proposals.filter(item=>item.status==='proposed').length,0);
  }finally{await f.cleanup();}
});

test('symlinked trash is rejected without removing the source',async()=>{
  const f=await fixture();const service=new Janitor({...f,active:()=>false,context:async()=>[],assertWritable:async()=>{},classify:async()=>({proposals:[{path:'scratch.log',reason:'Temporary'}]})});
  try{
    await service.startScan();await service.waitForScan();const id=(await service.status()).proposals[0].id;
    await symlink(f.directory,path.join(f.root,'.vibespace-trash'));
    assert.equal((await service.decide([id],'trash')).results[0].ok,false);
    assert.equal(await readFile(path.join(f.root,'scratch.log'),'utf8'),'temporary output');
  }finally{await f.cleanup();}
});

test('a persisted in-flight move is recovered after restart',async()=>{
  const f=await fixture();const options={...f,active:()=>false,context:async()=>[],assertWritable:async()=>{},classify:async()=>({proposals:[{path:'scratch.log',reason:'Temporary'}]})};
  try{
    const service=new Janitor(options);await service.startScan();await service.waitForScan();const id=(await service.status()).proposals[0].id;
    await service.decide([id],'trash');const raw=JSON.parse(await readFile(f.stateFile,'utf8'));raw.proposals[0].status='moving';await writeFile(f.stateFile,JSON.stringify(raw));
    const restarted=new Janitor(options);assert.equal((await restarted.status()).proposals[0].status,'trashed');
    assert.equal((await restarted.decide([id],'restore')).results[0].ok,true);
  }finally{await f.cleanup();}
});

test('concurrent scan requests do not create duplicate model runs',async()=>{
  const f=await fixture();let calls=0;let release:()=>void=()=>{};
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const service=new Janitor({...f,active:()=>false,context:async()=>[],assertWritable:async()=>{},classify:async()=>{calls++;await gate;return {proposals:[]};}});
  try{
    const starts=await Promise.allSettled([service.startScan(),service.startScan()]);
    assert.equal(starts.filter(result=>result.status==='fulfilled').length,1);
    release();await service.waitForScan();assert.equal(calls,1);
  }finally{release();await service.waitForScan();await f.cleanup();}
});
