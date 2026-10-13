import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { registerTaskLedgerSource, registerAgentLaunchContributor } from '../../../shared/index.js';
const dbRoot = await mkdtemp(path.join(os.tmpdir(),'claude-briefing-db-'));
process.env.DATABASE_PATH = path.join(dbRoot,'auth.db');
// eslint-disable-next-line boundaries/no-unknown -- Actual persistent provider integration without any provider request.
const { queryClaudeSDK, injectClaudeMessage, abortClaudeSDKSession, __setClaudeQueryImpl, __setClaudeInputControllerImpl } = await import('../../../claude-sdk.js');
const { initializeDatabase, closeConnection } = await import('../../database/index.js');
test.before(()=>initializeDatabase());
test.after(async()=>{closeConnection();await rm(dbRoot,{recursive:true,force:true});});

for (const scenario of ['repair','repeat','missing','late','launch','plain','helper','side']) test(`actual Claude stream: ${scenario}`, {timeout:15000},async()=>{
  const cwd=await mkdtemp(path.join(os.tmpdir(),'claude-briefing-'));
  const sid='claude-policy-'+scenario;
  const sent: any[]=[];const prompts: any[]=[];let present=scenario!=='late';
  const stopLaunch=registerAgentLaunchContributor(c=>scenario==='launch'&&c.sessionRole==='main'?{agentTextPolicy:'reject'}:null);
 const unregister=registerTaskLedgerSource(c=>c.sessionId===sid&&present&&scenario!=='plain'&&scenario!=='launch'? {listName:'card',guidance:'',open:[],activity:0,agentTextPolicy:'reject',...(scenario==='missing'?{completion:{turnId:'human',prompt:'reply exact threads'}}:{})}:null);
  __setClaudeQueryImpl(({prompt}: any)=>{
    const reader=prompt[Symbol.asyncIterator]();
    const gen=(async function*(){
      prompts.push((await reader.next()).value);
      present=true;
      yield {type:'assistant',session_id:sid,message:{role:'assistant',content:[{type:'text',text:'FORBIDDEN_INITIAL'},{type:'tool_use',id:'card',name:'mcp__mc__reply',input:{threadId:'exact'}}]}};
      yield {type:'result',subtype:'success',session_id:sid};
      if(['repair','repeat','missing','late','launch'].includes(scenario)){
        prompts.push((await reader.next()).value);
        yield {type:'assistant',session_id:sid,message:{role:'assistant',content:scenario==='repeat'?[{type:'text',text:'FORBIDDEN_AGAIN'}]:[{type:'tool_use',id:'second',name:'mcp__mc__reply',input:{threadId:'exact'}}]}};
        yield {type:'result',subtype:'success',session_id:sid};
      }
    })();
    (gen as any).interrupt=async()=>{}; return gen;
  });
  try{
    await queryClaudeSDK('actual incoming request',{sessionId:sid,cwd,ephemeral:scenario==='helper',sideSession:scenario==='side'?{id:'side'}:undefined},{send:(m:any)=>sent.push(m),setSessionId(){},userId:null});
    const output=sent.filter(m=>m.kind==='text'||m.kind==='stream_delta');
    assert.equal(output.some(m=>String(m.content).includes('FORBIDDEN')),['plain','helper','side'].includes(scenario));
    assert.ok(sent.some(m=>m.kind==='tool_use'));
    assert.equal(prompts.length,['repair','repeat','missing','late','launch'].includes(scenario)?2:1);
    if(['repeat','missing','launch'].includes(scenario)){assert.ok(sent.some(m=>m.kind==='error'&&String(m.content).includes('AGENT_TEXT_POLICY_VIOLATION')));assert.equal(sent.find(m=>m.kind==='complete').exitCode,1);}
    else assert.equal(sent.find(m=>m.kind==='complete').exitCode,0);
  }finally{stopLaunch();unregister();abortClaudeSDKSession(sid);__setClaudeQueryImpl(null);await rm(cwd,{recursive:true,force:true});}
});

test('actual persistent Claude: identical consecutive human queries require distinct host checkpoints', {timeout:15000},async()=>{
 const cwd=await mkdtemp(path.join(os.tmpdir(),'claude-identical-'));const sid='claude-identical';const ids:string[]=[];let calls=0;
 const stop=registerTaskLedgerSource(c=>{if(c.sessionId!==sid)return null;if(c.phase==='begin')ids.push(c.turnId!);return {listName:'card',guidance:'',open:[],activity:0,agentTextPolicy:'reject'};});
 __setClaudeQueryImpl(({prompt}:any)=>{calls++;const reader=prompt[Symbol.asyncIterator]();const gen=(async function*(){for(let i=0;i<2;i++){await reader.next();yield {type:'assistant',session_id:sid,message:{role:'assistant',content:[{type:'tool_use',id:'card-'+i,name:'mcp__mc__reply',input:{threadId:'exact'}}]}};yield {type:'result',subtype:'success',session_id:sid};}})();(gen as any).interrupt=async()=>{};return gen;});
 try {const ws={send(){},setSessionId(){},userId:null};await queryClaudeSDK('identical',{sessionId:sid,cwd},ws);const first=ids.at(-1);await queryClaudeSDK('identical',{sessionId:sid,cwd},ws);assert.equal(calls,1,'persistent SDK instance reused');assert.notEqual(ids.at(-1),first,'new human request gets new checkpoint despite identical text');}
 finally {stop();abortClaudeSDKSession(sid);__setClaudeQueryImpl(null);await rm(cwd,{recursive:true,force:true});}
});

test('actual rejected Claude steer preserves current human checkpoint', {timeout:15000},async()=>{
 const cwd=await mkdtemp(path.join(os.tmpdir(),'claude-rejected-steer-'));const sid='claude-rejected-steer';const ids:string[]=[];let controller:any;
 __setClaudeInputControllerImpl((input:any)=>{controller=input;return input;});
 const stop=registerTaskLedgerSource(c=>{if(c.sessionId!==sid)return null;if(c.phase==='begin')ids.push(c.turnId!);return {listName:'card',guidance:'',open:[],activity:0,agentTextPolicy:'reject'};});
 __setClaudeQueryImpl(({prompt}:any)=>{const reader=prompt[Symbol.asyncIterator]();const gen=(async function*(){await reader.next();yield {type:'system',subtype:'init',session_id:sid,capabilities:['msg_lifecycle_v1']};yield {type:'result',subtype:'success',session_id:sid};await reader.next();})();(gen as any).interrupt=async()=>{};return gen;});
 try {await queryClaudeSDK('human',{sessionId:sid,cwd},{send(){},setSessionId(){},userId:null});const before=[...ids];controller.push=()=>false;assert.equal(await injectClaudeMessage(sid,'human'),null);assert.deepEqual(ids,before,'refused push must not rotate checkpoint');}
 finally{stop();abortClaudeSDKSession(sid);__setClaudeQueryImpl(null);__setClaudeInputControllerImpl(null);await rm(cwd,{recursive:true,force:true});}
});
