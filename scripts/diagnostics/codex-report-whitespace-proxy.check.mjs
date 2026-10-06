import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {writeFile,readFile,chmod,mkdtemp,stat,copyFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const directory=process.argv[2];
if(!directory)throw new Error('Pass an allocated tracked artifact directory');
const runDirectory=await mkdtemp(join(directory,'proxy-check-'));
const fake=join(runDirectory,'fake-native.mjs');
const proxy=fileURLToPath(new URL('./codex-report-whitespace-proxy.mjs',import.meta.url));
const target='11111111-1111-1111-1111-111111111111',foreign='22222222-2222-2222-2222-222222222222';
const messages=[
 {method:'rawResponseItem/completed',params:{threadId:foreign,turnId:'turn',item:{type:'custom_tool_call',name:'exec',call_id:'foreign-call',input:'tools.mcp__mc__reply({text:"FOREIGN_PROSE_SECRET"})'}}},
 {method:'rawResponseItem/completed',params:{threadId:target,turnId:'turn',item:{type:'message',role:'user',content:[{text:'AUTH_PROMPT_SECRET'}]}}},
 {method:'rawResponseItem/completed',params:{threadId:target,turnId:'turn',item:{type:'custom_tool_call',name:'exec',call_id:'source-id',input:'tools.mcp__mc__reply({text:"42 теста"})'}}},
 {method:'item/tool/call',params:{threadId:target,turnId:'turn',callId:'dynamic-id',tool:'mcp__mc__reply',arguments:{text:'42теста',auth:'AUTH_ARGUMENT_SECRET'}}},
 {method:'turn/completed',params:{threadId:target,turnId:'turn'}},
];
const expected=Buffer.from(messages.map(x=>JSON.stringify(x)+'\n').join(''));
await writeFile(fake,`#!/usr/bin/env node
import fs from 'node:fs';
const bytes=fs.readFileSync(process.env.PROXY_CHECK_OUTPUT);
if(process.env.PROXY_CHECK_EARLY)await new Promise(r=>process.stdout.write(bytes,r));
const chunks=[];for await(const c of process.stdin)chunks.push(c);
fs.writeFileSync(process.env.PROXY_CHECK_INPUT,JSON.stringify({argv:process.argv.slice(2),input:Buffer.concat(chunks).toString('base64')}));
if(!process.env.PROXY_CHECK_EARLY){
 if(process.env.PROXY_CHECK_BYTEWISE)for(const byte of bytes)await new Promise(r=>process.stdout.write(Buffer.from([byte]),r));
 else await new Promise(r=>process.stdout.write(bytes,r));
}
process.stderr.write('native-stderr-sentinel\\n');process.exitCode=Number(process.env.PROXY_CHECK_EXIT)||0;
`);await chmod(fake,0o755);
const args=['app-server','--listen','stdio://','literal arg with spaces','--sentinel=🙂'];
const plain=Buffer.concat([Buffer.from(' { "id":9,"method":"thread/resume", "params":{"threadId":"'+foreign+'"}}\r\nnull\nnot JSON\n {"method":"thread/start"}\n'),Buffer.from([0xff,0xfe,10]),Buffer.from('{ "method": "unrelated", "text": "🙂 42 теста" }')]);
async function run(label,{enabled=true,input=plain,stdout=expected,output=join(runDirectory,label+'-diagnostics.jsonl'),extraEnv={},wrapper=proxy,bytewise=false,staggerInput=false}={}){
 const capture=join(runDirectory,label+'-input.json'),fixtureOutput=join(runDirectory,label+'-stdout.bin');
 await writeFile(fixtureOutput,stdout);
 const env={...process.env,VIBESPACE_CODEX_DIAGNOSTIC_NATIVE:fake,PROXY_CHECK_INPUT:capture,PROXY_CHECK_OUTPUT:fixtureOutput,PROXY_CHECK_BYTEWISE:bytewise?'1':''};
 delete env.VIBESPACE_CODEX_DIAGNOSTIC_THREAD;delete env.VIBESPACE_CODEX_DIAGNOSTIC_OUTPUT;delete env.NODE_OPTIONS;
 if(enabled){env.VIBESPACE_CODEX_DIAGNOSTIC_THREAD=target;env.VIBESPACE_CODEX_DIAGNOSTIC_OUTPUT=output;}
 Object.assign(env,extraEnv);
 const child=spawn(process.execPath,[wrapper,...args],{env,stdio:['pipe','pipe','pipe']});const received=[];let stderr='';
 child.stdout.on('data',b=>received.push(b));child.stderr.on('data',b=>stderr+=b.toString());
 // A bounded fake executable only. Node's timeout kills this exact owned child, never a name.
 const timer=setTimeout(()=>child.kill('SIGKILL'),15000);
 const done=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',(code,signal)=>signal?reject(new Error(label+' timed out '+signal)):resolve(code));});
 child.stdin.on('error',()=>{});let inputTimer;
 if(staggerInput){child.stdin.write(input.subarray(0,3));inputTimer=setTimeout(()=>child.stdin.end(input.subarray(3)),400);}else child.stdin.end(input);
 let code;try{code=await done;}finally{clearTimeout(timer);clearTimeout(inputTimer);}
 assert.equal(code,Number(extraEnv.PROXY_CHECK_EXIT)||0,label+' native exit code; '+stderr);
 assert.deepEqual(Buffer.concat(received),stdout,label+' stdout bytes');
 const receipt=JSON.parse(await readFile(capture,'utf8'));
 assert.deepEqual(receipt.argv,args,label+' native argv');
 assert.ok(stderr.includes('native-stderr-sentinel'),label+' native stderr');
 return {input:Buffer.from(receipt.input,'base64'),output,stderr};
}
const disabled=await run('disabled',{enabled:false,bytewise:true});assert.deepEqual(disabled.input,plain);
const enabled=await run('enabled',{bytewise:true});assert.deepEqual(enabled.input,plain);
assert.equal((await stat(enabled.output)).mode&0o777,0o600);
const captured=await readFile(enabled.output,'utf8');
for(const value of ['FOREIGN_PROSE_SECRET','AUTH_PROMPT_SECRET','AUTH_ARGUMENT_SECRET','42 теста','42теста'])assert.equal(captured.includes(value),false);
const records=captured.trim().split('\n').map(JSON.parse),comparison=records.find(x=>x.type==='comparison');
assert.equal(comparison.rawToForwarded,'preserved');assert.equal(comparison.forwardedToTool,'changed');
assert.equal(records[0].argvSha256,createHash('sha256').update(JSON.stringify(args)).digest('hex'));
assert.equal(records[0].nativeExecutableSha256,createHash('sha256').update(await readFile(fake)).digest('hex'));
assert.equal(records.at(-1).type,'terminal');
const handshake=[{id:1,method:'initialize',params:{clientInfo:{name:'fixture'},capabilities:{other:true}}},{id:2,method:'thread/resume',params:{threadId:foreign}},{id:3,method:'thread/resume',params:{threadId:target}}];
const injection=await run('injection',{input:Buffer.from(handshake.map(x=>JSON.stringify(x)+'\n').join(''))});
const injected=injection.input.toString().trim().split('\n').map(JSON.parse);
assert.equal(injected[0].params.capabilities.experimentalApi,true);assert.equal(injected[0].params.capabilities.other,true);
assert.deepEqual(injected[1],handshake[1]);assert.equal(injected[2].params.experimentalRawEvents,true);
const collision=await run('collision',{output:enabled.output});assert.deepEqual(collision.input,plain);assert.match(collision.stderr,/capture-setup \(EEXIST\)/);assert.equal(await readFile(enabled.output,'utf8'),captured);
const simultaneous=await Promise.all([run('concurrent-a',{output:join(runDirectory,'concurrent.jsonl')}),run('concurrent-b',{output:join(runDirectory,'concurrent.jsonl')})]);
assert.equal(simultaneous.filter(r=>/EEXIST/.test(r.stderr)).length,1);for(const r of simultaneous)assert.deepEqual(r.input,plain);
for(const [label,extraEnv,output] of [
 ['missing-directory',{},join(runDirectory,'absent','capture.jsonl')],
 ['directory-output',{},runDirectory],
 ['invalid-thread',{VIBESPACE_CODEX_DIAGNOSTIC_THREAD:'------------------------------------'},undefined],
 ['relative-output',{},'relative-output.jsonl'],
]){const r=await run(label,{extraEnv,output});assert.deepEqual(r.input,plain);assert.match(r.stderr,/disabled: (capture-setup|configuration)/);assert.equal(r.stderr.includes(runDirectory),false);}
const isolated=join(runDirectory,'without-parser');await mkdir(isolated);await copyFile(proxy,join(isolated,'proxy.mjs'));
for(const active of [false,true]){const r=await run('missing-parser-'+active,{enabled:active,wrapper:join(isolated,'proxy.mjs')});assert.deepEqual(r.input,plain);if(active)assert.match(r.stderr,/capture-setup \(ERR_MODULE_NOT_FOUND\)/);}
async function fault(label,source,options={}){
 const preload=join(runDirectory,label+'-preload.mjs');
 // NODE_OPTIONS reaches the fake native too; inject faults only into the owned proxy.
 await writeFile(preload,`if(process.argv[1]===${JSON.stringify(proxy)})await import(${JSON.stringify('data:text/javascript,'+encodeURIComponent(source))});`);
 const r=await run(label,{...options,extraEnv:{NODE_OPTIONS:'--import='+pathToFileURL(preload).href}});
 assert.deepEqual(r.input,options.input??plain);return r;
}
const denied=await fault('access-denied',`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const original=fs.openSync;fs.openSync=(p,...args)=>{if(String(p).endsWith('-diagnostics.jsonl'))throw Object.assign(new Error('SECRET_PATH'),{code:'EACCES'});return original(p,...args)};syncBuiltinESMExports();`);
assert.match(denied.stderr,/capture-setup \(EACCES\)/);assert.equal(denied.stderr.includes('SECRET_PATH'),false);
const writeFailed=await fault('write-failed',`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';fs.writeSync=()=>{throw Object.assign(new Error('SECRET_PATH'),{code:'ENOSPC'})};syncBuiltinESMExports();`);
assert.match(writeFailed.stderr,/capture-write \(ENOSPC\)/);assert.equal(writeFailed.stderr.includes('SECRET_PATH'),false);
const shortWrite=await fault('short-write',`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const original=fs.writeSync;fs.writeSync=(fd,b,o,l)=>original(fd,b,o,Math.min(l,17));syncBuiltinESMExports();`);
assert.doesNotMatch(shortWrite.stderr,/disabled/);assert.equal((await readFile(shortWrite.output,'utf8')).trim().split('\n').map(JSON.parse).at(-1).type,'terminal');
const zeroWrite=await fault('zero-write',`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';fs.writeSync=()=>0;syncBuiltinESMExports();`);
assert.match(zeroWrite.stderr,/capture-write/);
// Actual parser stack exhaustion from adversarial nesting, within the source byte cap.
const nested={method:'rawResponseItem/completed',params:{threadId:target,turnId:'turn',item:{type:'custom_tool_call',name:'exec',call_id:'nested',input:'('.repeat(20000)+'"SECRET_SOURCE"'+')'.repeat(20000)}}};
const parserFailed=await run('parser-failed',{stdout:Buffer.from(JSON.stringify(nested)+'\n')});
assert.deepEqual(parserFailed.input,plain);assert.match(parserFailed.stderr,/output-observer/);assert.equal(parserFailed.stderr.includes('SECRET_SOURCE'),false);
const pendingInput=await run('pending-input-failure',{stdout:Buffer.from(JSON.stringify(nested)+'\n'),extraEnv:{PROXY_CHECK_EARLY:'1'},staggerInput:true});
assert.deepEqual(pendingInput.input,plain);assert.match(pendingInput.stderr,/output-observer/);
const hugeInput=Buffer.concat([Buffer.alloc(8*1024*1024+1,32),Buffer.from('after input cap\n')]);
const inputLimit=await run('input-limit',{input:hugeInput});assert.deepEqual(inputLimit.input,hugeInput);assert.match(inputLimit.stderr,/input-buffer-limit/);
const hugeOutput=Buffer.concat([Buffer.alloc(8*1024*1024+1,32),expected]);
const outputLimit=await run('output-buffer-limit',{stdout:hugeOutput});assert.deepEqual(outputLimit.input,plain);assert.match(outputLimit.stderr,/output-buffer-limit/);
const largeMessage={method:'item/tool/call',params:{threadId:target,turnId:'turn',callId:'large-id',tool:'mcp__mc__reply',arguments:{text:' '.repeat(50000)}}};
const cap=await run('output-limit',{stdout:Buffer.from(Array.from({length:4},()=>JSON.stringify(largeMessage)+'\n').join(''))});
assert.deepEqual(cap.input,plain);assert.match(cap.stderr,/output-limit/);assert.ok((await stat(cap.output)).size<=1024*1024);
const malformed=await run('malformed-output',{stdout:Buffer.concat([Buffer.from('null\nnot-json\n'),Buffer.from([0xff,0xfe,10]),expected])});assert.deepEqual(malformed.input,plain);assert.doesNotMatch(malformed.stderr,/disabled/);
await run('native-exit',{enabled:false,extraEnv:{PROXY_CHECK_EXIT:'7'}});
console.log('PASS: byte-exact argv/stdin/stdout, scoped injection, private bounded fingerprints, collisions/concurrency, setup/runtime/parser/write/cap failures, short writes, native exit; fixtures: '+runDirectory);
