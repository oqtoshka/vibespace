#!/usr/bin/env node
import {StringDecoder} from 'node:string_decoder';
import {spawn} from 'node:child_process';
import {openSync,writeSync,closeSync,readFileSync,realpathSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {ReportWhitespaceObserver} from './codex-report-whitespace.mjs';

const native=process.env.VIBESPACE_CODEX_DIAGNOSTIC_NATIVE;
const target=process.env.VIBESPACE_CODEX_DIAGNOSTIC_THREAD;
const output=process.env.VIBESPACE_CODEX_DIAGNOSTIC_OUTPUT;
if(!native||!isAbsolute(native))throw new Error('Explicit absolute native CLI path required; never resolves itself.');
if(realpathSync(native)===realpathSync(fileURLToPath(import.meta.url)))throw new Error('Native CLI must differ from diagnostic wrapper.');
const enabled=Boolean(target);
if(enabled&&(!/^[0-9a-f-]{36}$/i.test(target)||!output||!isAbsolute(output)))throw new Error('One native UUID and absolute exclusive output path required.');
const fd=enabled?openSync(output,'wx',0o600):null;
let diagnosticsActive=enabled,diagnosticBytes=0;
const emit=x=>{if(!diagnosticsActive)return;try{const line=JSON.stringify(x)+'\n';diagnosticBytes+=Buffer.byteLength(line);if(diagnosticBytes>1024*1024){diagnosticsActive=false;return;}writeSync(fd,line);}catch{diagnosticsActive=false;}};
const observer=enabled?new ReportWhitespaceObserver(target,emit):null;
const args=process.argv.slice(2);
const child=spawn(native,args,{stdio:['pipe','pipe','inherit']});
let nativeExecutableSha256;try{nativeExecutableSha256=createHash('sha256').update(readFileSync(realpathSync(native))).digest('hex');}catch{}
emit({type:'source-provenance',nativeExecutableSha256,sourceBoundary:'native-app-server-stdout; not upstream HTTP or final consumer',nativePid:child.pid,argvSha256:createHash('sha256').update(JSON.stringify(args)).digest('hex'),threadId:target});
let input='',outputBuffer='';
const inputDecoder=new StringDecoder('utf8'),outputDecoder=new StringDecoder('utf8');
function inputLine(line){
 let m;try{m=JSON.parse(line);}catch{child.stdin.write(line+'\n');return;}
 if(enabled&&m.method==='initialize')m.params={...m.params,capabilities:{...m.params?.capabilities,experimentalApi:true}};
 if(enabled&&m.method==='thread/resume'&&m.params?.threadId===target)m.params={...m.params,experimentalRawEvents:true};
 child.stdin.write(JSON.stringify(m)+'\n');
}
process.stdin.on('data',chunk=>{
 if(!enabled){child.stdin.write(chunk);return;}
 input+=inputDecoder.write(chunk);let end;while((end=input.indexOf('\n'))>=0){inputLine(input.slice(0,end));input=input.slice(end+1);}
});
process.stdin.on('end',()=>{input+=inputDecoder.end();if(input)inputLine(input);child.stdin.end();});
child.stdout.on('data',chunk=>{
 // Parent bytes are forwarded verbatim. Diagnostics never rewrites output.
 process.stdout.write(chunk);
 if(!observer||!diagnosticsActive)return;
 outputBuffer+=outputDecoder.write(chunk);if(outputBuffer.length>8*1024*1024){diagnosticsActive=false;outputBuffer='';return;}let end;
 while((end=outputBuffer.indexOf('\n'))>=0){
  const line=outputBuffer.slice(0,end);outputBuffer=outputBuffer.slice(end+1);
  let m;try{m=JSON.parse(line);}catch{continue;}
  try{observer.observe(m,'native-raw');observer.observe(m,'forwarded-code-mode');
  if(m.method==='item/tool/call'||m.method==='item/started')observer.observe(m,'outgoing-report-tool');}catch{diagnosticsActive=false;outputBuffer='';return;}
 }
});
child.stdin.on('error',()=>{});
child.on('error',()=>{emit({type:'terminal',kind:'native-launch-error'});if(fd!==null)try{closeSync(fd);}catch{};process.exitCode=1;});
child.on('exit',(code,signal)=>{emit({type:'terminal',exitCode:code,signal});if(fd!==null)try{closeSync(fd);}catch{};process.exitCode=code??1;});
// Propagate only to our exact native child. Parent owns normal process deadline.
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));
