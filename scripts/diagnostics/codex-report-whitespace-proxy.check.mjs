import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {writeFile,readFile,chmod,mkdtemp} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
const directory=process.argv[2];
if(!directory)throw new Error('Pass an allocated tracked artifact directory');
const runDirectory=await mkdtemp(join(directory,'proxy-check-'));
const fake=join(runDirectory,'fake-native.mjs'),output=join(runDirectory,'proxy-safe.jsonl');
const target='11111111-1111-1111-1111-111111111111',foreign='22222222-2222-2222-2222-222222222222';
const messages=[
 {method:'rawResponseItem/completed',params:{threadId:foreign,turnId:'turn',item:{type:'custom_tool_call',name:'exec',call_id:'foreign-call',input:'tools.mcp__mc__reply({text:"FOREIGN_PROSE_SECRET"})'}}},
 {method:'rawResponseItem/completed',params:{threadId:target,turnId:'turn',item:{type:'message',role:'user',content:[{text:'AUTH_PROMPT_SECRET'}]}}},
 {method:'rawResponseItem/completed',params:{threadId:target,turnId:'turn',item:{type:'custom_tool_call',name:'exec',call_id:'source-id',input:'tools.mcp__mc__reply({text:"42 теста"})'}}},
 {method:'item/tool/call',params:{threadId:target,turnId:'turn',callId:'dynamic-id',tool:'mcp__mc__reply',arguments:{text:'42теста',auth:'AUTH_ARGUMENT_SECRET'}}},
 {method:'turn/completed',params:{threadId:target,turnId:'turn'}},
];
const expected=messages.map(x=>JSON.stringify(x)+'\n').join('');
await writeFile(fake,`#!/usr/bin/env node\nimport fs from 'node:fs';\nlet input='';for await(const c of process.stdin)input+=c;fs.writeFileSync(process.env.PROXY_CHECK_INPUT,input);\nconst bytes=Buffer.from(${JSON.stringify(expected)});for(const byte of bytes)await new Promise(r=>process.stdout.write(Buffer.from([byte]),r));\n`);await chmod(fake,0o755);
const input=[{id:1,method:'initialize',params:{clientInfo:{name:'fixture'}}},{id:2,method:'thread/resume',params:{threadId:foreign}},{id:3,method:'thread/resume',params:{threadId:target}}];
async function run(enabled,label){
 const capture=join(runDirectory,label+'-input.jsonl');
 const env={...process.env,VIBESPACE_CODEX_DIAGNOSTIC_NATIVE:fake,PROXY_CHECK_INPUT:capture};
 delete env.VIBESPACE_CODEX_DIAGNOSTIC_THREAD;delete env.VIBESPACE_CODEX_DIAGNOSTIC_OUTPUT;
 if(enabled){env.VIBESPACE_CODEX_DIAGNOSTIC_THREAD=target;env.VIBESPACE_CODEX_DIAGNOSTIC_OUTPUT=output;}
 const proxy=fileURLToPath(new URL('./codex-report-whitespace-proxy.mjs',import.meta.url));
 const child=spawn(process.execPath,[proxy,'app-server'],{env,stdio:['pipe','pipe','pipe']});const stdout=[];let stderr='';
 child.stdout.on('data',b=>stdout.push(b));child.stderr.on('data',b=>stderr+=b.toString());
 const done=new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error('proxy exit '+code+' '+stderr)));});
 child.stdin.end(input.map(x=>JSON.stringify(x)+'\n').join(''));await done;
 assert.deepEqual(Buffer.concat(stdout),Buffer.from(expected));return (await readFile(capture,'utf8')).trim().split('\n').map(JSON.parse);
}
const unchanged=await run(false,'disabled');assert.deepEqual(unchanged,input);
const enabled=await run(true,'enabled');assert.equal(enabled[0].params.capabilities.experimentalApi,true);assert.equal(enabled[1].params.experimentalRawEvents,undefined);assert.equal(enabled[2].params.experimentalRawEvents,true);
const captured=await readFile(output,'utf8');for(const value of ['FOREIGN_PROSE_SECRET','AUTH_PROMPT_SECRET','AUTH_ARGUMENT_SECRET','42 теста','42теста'])assert.equal(captured.includes(value),false);
const comparison=captured.trim().split('\n').map(JSON.parse).find(x=>x.type==='comparison');assert.equal(comparison.rawToForwarded,'preserved');assert.equal(comparison.forwardedToTool,'changed');
console.log('PASS: disabled identity; target-only opt-in; bytewise UTF8 forwarding; deletion detection; no-secret diagnostic output');
