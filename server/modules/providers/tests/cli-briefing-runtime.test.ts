import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
const dir=await mkdtemp(path.join(os.tmpdir(),'cli-briefing-'));process.env.DATABASE_PATH=path.join(dir,'auth.db');
const { registerTaskLedgerSource, registerAgentLaunchContributor }=await import('../../../shared/index.js');
const { initializeDatabase,closeConnection }=await import('../../database/index.js');
// eslint-disable-next-line boundaries/no-unknown -- Actual owned executable CLI fixture, no provider connection.
const {spawnCursor}=await import('../../../cursor-cli.js');
// eslint-disable-next-line boundaries/no-unknown -- Actual owned executable CLI fixture, no provider connection.
const {spawnOpenCode}=await import('../../../opencode-cli.js');
const {CursorSessionsProvider}=await import('../list/cursor/cursor-sessions.provider.js');
const {OpenCodeSessionsProvider}=await import('../list/opencode/opencode-sessions.provider.js');
const prevPath=process.env.PATH;test.before(()=>initializeDatabase());
test.after(async()=>{process.env.PATH=prevPath;await new Promise(r=>setTimeout(r,100));closeConnection();await rm(dir,{recursive:true,force:true});});
for(const provider of ['cursor','opencode'] as const)for(const scenario of ['repair','repeat','plain','missing','helper','side','late','launch'])test(`actual ${provider} CLI: ${scenario}`,{timeout:15000},async()=>{
 const bin=path.join(dir,provider+'-'+scenario);await mkdir(bin);const capture=path.join(bin,'calls');const sid=provider+'-policy-'+scenario;
 await writeFile(path.join(bin,provider==='cursor'?'cursor-agent':'opencode'),`#!/usr/bin/env node
const fs=require('node:fs');if(process.argv[2]==='models'){process.exit(0)}
const count=fs.existsSync(${JSON.stringify(capture)})?fs.readFileSync(${JSON.stringify(capture)},'utf8').trim().split('\\n').length:0;
fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify(process.argv.slice(2))+'\\n');
const send=v=>console.log(JSON.stringify(v));
if(${scenario==='late'})fs.writeFileSync(${JSON.stringify(path.join(bin,'sidecar'))},'briefing');
if(${scenario==='late'})send(${provider==='cursor'?`{type:'assistant',session_id:${JSON.stringify(sid)},message:{role:'assistant',content:[{type:'tool_use',id:'first',name:'reply',input:{}}]}}`:`{type:'tool_use',sessionID:${JSON.stringify(sid)},part:{type:'tool',callID:'first',tool:'reply',state:{status:'completed',input:{},output:'stored'}}}`} );
${provider==='cursor'?`send({type:'system',subtype:'init',session_id:${JSON.stringify(sid)}});if(count===0||${scenario==='repeat'})send({type:'assistant',session_id:${JSON.stringify(sid)},message:{role:'assistant',content:[{type:'text',text:'FORBIDDEN_CLI'},{type:'tool_use',id:'card',name:'reply',input:{}}]}});send({type:'result',subtype:'success'});`:`if(count===0||${scenario==='repeat'})send({type:'text',sessionID:${JSON.stringify(sid)},part:{text:'FORBIDDEN_CLI'}});send({type:'tool_use',sessionID:${JSON.stringify(sid)},part:{type:'tool',callID:'card',tool:'reply',state:{status:'completed',input:{},output:'stored'}}});send({type:'step_finish',sessionID:${JSON.stringify(sid)}});`}
`,{mode:0o755});
 process.env.PATH=bin+path.delimiter+prevPath;
 let sidecarReady=scenario!=='late';
 const stopLaunch=registerAgentLaunchContributor(c=>scenario==='launch'&&c.sessionRole==='main'?{agentTextPolicy:'reject'}:null);
 const unregister=registerTaskLedgerSource(c=>c.sessionId===sid&&(sidecarReady||existsSync(path.join(bin,'sidecar')))&&scenario!=='plain'&&scenario!=='launch'?{listName:'card',guidance:'',open:[],activity:0,agentTextPolicy:'reject',...(scenario==='missing'?{completion:{turnId:'human',prompt:'exact reply'}}:{})}:null);
 const normalizer=provider==='cursor'?new CursorSessionsProvider():new OpenCodeSessionsProvider();
 const runtime:any={resolveProviderSessionId:(id:string)=>id||null,resolveResumeModel:async()=>undefined,getProviderModels:async()=>({OPTIONS:[],DEFAULT:''}),normalizeMessage:(raw:any,id:string)=>normalizer.normalizeMessage(raw,id),isProviderInstalled:async()=>true};
 const sent:any[]=[];
 try{await(provider==='cursor'?spawnCursor:spawnOpenCode)('request',{sessionId:sid,cwd:dir,ephemeral:scenario==='helper',sideSession:scenario==='side'?{id:'side'}:undefined,skipPermissions:true},{send:(m:any)=>{sent.push(m);if(m.kind==='tool_use')sidecarReady=true;},setSessionId(){}},runtime);
  const calls=(await readFile(capture,'utf8')).trim().split('\n');assert.equal(calls.length,['repair','repeat','missing','late','launch'].includes(scenario)?2:1);
  assert.equal(sent.some(m=>['text','stream_delta'].includes(m.kind)&&String(m.content).includes('FORBIDDEN')),['plain','helper','side'].includes(scenario));
  const completed=sent.filter(m=>m.kind==='complete');assert.equal(completed.length,1);
  assert.equal(completed[0].success,!['repeat','missing','launch'].includes(scenario));
  if(['repeat','missing','launch'].includes(scenario))assert.ok(sent.some(m=>m.kind==='error'&&String(m.content).includes('AGENT_TEXT_POLICY_VIOLATION')));
 }finally{stopLaunch();unregister();process.env.PATH=prevPath;}
});
