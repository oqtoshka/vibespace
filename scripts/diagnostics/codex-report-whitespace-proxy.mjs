#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {openSync,writeSync,closeSync,readFileSync,realpathSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const native=process.env.VIBESPACE_CODEX_DIAGNOSTIC_NATIVE;
const target=process.env.VIBESPACE_CODEX_DIAGNOSTIC_THREAD;
const output=process.env.VIBESPACE_CODEX_DIAGNOSTIC_OUTPUT;
if(!native||!isAbsolute(native))throw new Error('Explicit absolute native CLI path required; never resolves itself.');
// Invalid native configuration is a launch failure, not a capture failure.
let nativeRealpath;try{nativeRealpath=realpathSync(native);}catch{}
if(nativeRealpath===realpathSync(fileURLToPath(import.meta.url)))throw new Error('Native CLI must differ from diagnostic wrapper.');

const MAX_OUTPUT=1024*1024,MAX_BUFFER=8*1024*1024;
let fd=null,diagnosticsActive=false,diagnosticBytes=0,observer;
let input=Buffer.alloc(0),outputBuffer=Buffer.alloc(0),child;
function forwardInput(bytes){if(bytes.length&&!child.stdin.write(bytes))process.stdin.pause();}
function flushInput(){if(child&&input.length){const pending=input;input=Buffer.alloc(0);forwardInput(pending);}}
function closeCapture(){if(fd!==null){try{closeSync(fd);}catch{}fd=null;}}
function disable(reason,error,flush=true){
 diagnosticsActive=false;observer=undefined;outputBuffer=Buffer.alloc(0);closeCapture();
 // Fixed labels and system error codes only: no file paths, source, or exception text.
 const code=/^[A-Z][A-Z0-9_]+$/.test(error?.code??'')?` (${error.code})`:'';
 try{process.stderr.write(`[whitespace diagnostic] disabled: ${reason}${code}; transport continues\n`);}catch{}
 if(flush)flushInput();
}
function emit(record){
 if(!diagnosticsActive)return;
 try{
  const bytes=Buffer.from(JSON.stringify(record)+'\n');
  if(diagnosticBytes+bytes.length>MAX_OUTPUT){disable('output-limit');return;}
  // Account actual writes; a short write must never silently produce valid-looking evidence.
  let offset=0;while(offset<bytes.length){const written=writeSync(fd,bytes,offset,bytes.length-offset);if(written<=0)throw new Error('short write');offset+=written;diagnosticBytes+=written;}
 }catch(error){disable('capture-write',error);}
}
if(target){
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target)||!output||!isAbsolute(output))disable('configuration');
 else try{
  // Load the optional parser only inside the failure boundary. Missing runtime dependencies
  // must not break the disabled wrapper or the native transport.
  const {ReportWhitespaceObserver}=await import('./codex-report-whitespace.mjs');
  fd=openSync(output,'wx',0o600);diagnosticsActive=true;
  observer=new ReportWhitespaceObserver(target,emit);
 }catch(error){disable('capture-setup',error);}
}
const args=process.argv.slice(2);
child=spawn(native,args,{stdio:['pipe','pipe','inherit']});
if(diagnosticsActive){
 let nativeExecutableSha256;try{nativeExecutableSha256=createHash('sha256').update(readFileSync(nativeRealpath??native)).digest('hex');}catch{}
 emit({type:'source-provenance',nativeExecutableSha256,sourceBoundary:'native-app-server-stdout; not upstream HTTP or final consumer',nativePid:child.pid,argvSha256:createHash('sha256').update(JSON.stringify(args)).digest('hex'),threadId:target});
}
function inputLine(bytes){
 let m;try{m=JSON.parse(bytes.toString('utf8'));}catch{forwardInput(bytes);return;}
 try{
  // Only initialize has a supported opt-in on a resumed thread. Codex 0.159.3 exposes
  // experimentalRawEvents on thread/start, not thread/resume; an unknown resume field
  // does not establish raw capture. Do not start another thread to obtain that option.
  // Preserve every other byte, including
  // formatting, CRLF, invalid UTF8, and an unterminated last line.
  if(m?.method==='initialize')m.params={...m.params,capabilities:{...m.params?.capabilities,experimentalApi:true}};
  else if(m?.method==='thread/resume'&&m.params?.threadId===target){
   emit({type:'capture-boundary',boundary:'native-raw',availability:'not-established',reason:'resume-has-no-raw-opt-in',threadId:target});
   forwardInput(bytes);return;
  }
  else{forwardInput(bytes);return;}
  forwardInput(Buffer.from(JSON.stringify(m)+(bytes.at(-1)===10?'\n':'')));
 }catch(error){disable('input-observer',error,false);forwardInput(bytes);flushInput();}
}
process.stdin.on('data',chunk=>{
 if(!diagnosticsActive){forwardInput(chunk);return;}
 input=Buffer.concat([input,chunk]);
 if(input.length>MAX_BUFFER){disable('input-buffer-limit');return;}
 let end;while(diagnosticsActive&&(end=input.indexOf(10))>=0){const line=input.subarray(0,end+1);input=input.subarray(end+1);inputLine(line);}
});
process.stdin.on('end',()=>{
 if(input.length){const pending=input;input=Buffer.alloc(0);if(diagnosticsActive)inputLine(pending);else forwardInput(pending);}
 child.stdin.end();
});
child.stdin.on('drain',()=>process.stdin.resume());
child.stdout.on('data',chunk=>{
 // Forward first, independently of diagnostics; stdout bytes are never rewritten.
 if(!process.stdout.write(chunk)){child.stdout.pause();process.stdout.once('drain',()=>child.stdout.resume());}
 if(!observer||!diagnosticsActive)return;
 try{
  outputBuffer=Buffer.concat([outputBuffer,chunk]);
  if(outputBuffer.length>MAX_BUFFER){disable('output-buffer-limit');return;}
  let end;while(diagnosticsActive&&(end=outputBuffer.indexOf(10))>=0){
   const line=outputBuffer.subarray(0,end);outputBuffer=outputBuffer.subarray(end+1);
   let m;try{m=JSON.parse(line.toString('utf8'));}catch{continue;}
   const currentObserver=observer;
   currentObserver.observe(m,'native-raw');
   if(!diagnosticsActive)return;
   currentObserver.observe(m,'forwarded-code-mode');
   if(diagnosticsActive&&(m?.method==='item/tool/call'||m?.method==='item/started'))currentObserver.observe(m,'outgoing-report-tool');
  }
 }catch(error){disable('output-observer',error);}
});
child.stdin.on('error',()=>{});
child.on('error',()=>{emit({type:'terminal',kind:'native-launch-error'});closeCapture();process.exitCode=1;});
// 'close' follows drained stdio; 'exit' can precede the final stdout evidence.
child.on('close',(code,signal)=>{emit({type:'terminal',exitCode:code,signal});closeCapture();process.exitCode=code??1;});
// Propagate only to our exact native child. Parent owns normal process deadline.
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));
