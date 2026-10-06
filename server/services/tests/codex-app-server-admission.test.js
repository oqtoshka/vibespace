import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getCodexAppServer, stopCodexAppServer, getExistingCodexAppServerTransports } from '../codex-app-server.service.js';
import { codexRestartAdmissionObserver } from '../../modules/providers/index.js';
// Real existing transport boundary with a tiny deterministic protocol peer.
// This test starts only its own fake peers and never contacts a model/provider.
test('actual cached shared/private peers are inspected over the same transports with no third spawn',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'codex-admission-'));
 const executable=path.join(dir,'fake-codex');const capture=path.join(dir,'pids.jsonl');
 const previous=process.env.VIBESPACE_CODEX_PATH;
 try {
  await writeFile(executable,`#!/usr/bin/env node
const fs=require('node:fs');const rl=require('node:readline').createInterface({input:process.stdin});
fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify({pid:process.pid})+'\\n');
rl.on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;
let result;if(m.method==='initialize')result={userAgent:'fake'};
else if(m.method==='thread/loaded/list')result={data:['parent','child'],nextCursor:null};
else if(m.method==='thread/read')result={thread:{id:m.params.threadId,status:{type:m.params.threadId==='child'?'active':'idle'},parentThreadId:m.params.threadId==='child'?'parent':null,preview:'SECRET_PROMPT'}};
else {process.stdout.write(JSON.stringify({id:m.id,error:{code:-32601,message:'unsupported'}})+'\\n');return;}
process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');});
`);
  await chmod(executable,0o755);process.env.VIBESPACE_CODEX_PATH=executable;
  const shared=await getCodexAppServer();const privatePeer=await getCodexAppServer({private:true});
  const result=await codexRestartAdmissionObserver.observe();
  assert.equal(result.variants.length,2);assert.equal(result.nativeThreadsIdle,false);
  assert.equal(result.variants.every(v=>v.activeChildThreads===1),true);
  assert.equal(getExistingCodexAppServerTransports()[0].client,shared);
  assert.equal(getExistingCodexAppServerTransports()[1].client,privatePeer);
  assert.equal((await readFile(capture,'utf8')).trim().split('\n').length,2);
  assert.ok(!JSON.stringify(result).includes('SECRET_PROMPT'));
 } finally {
  stopCodexAppServer();
  if(previous===undefined)delete process.env.VIBESPACE_CODEX_PATH;else process.env.VIBESPACE_CODEX_PATH=previous;
  await rm(dir,{recursive:true,force:true});
 }
});
