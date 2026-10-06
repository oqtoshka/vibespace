import test from 'node:test';
import assert from 'node:assert/strict';
import {fingerprint,reportLiterals,ReportWhitespaceObserver} from './codex-report-whitespace.mjs';
const thread='native-thread';
const raw=(input,id='source-id',turn='turn')=>({method:'rawResponseItem/completed',params:{threadId:thread,turnId:turn,item:{type:'custom_tool_call',name:'exec',input,call_id:id}}});
const tool=text=>({method:'item/tool/call',params:{threadId:thread,turnId:'turn',callId:'dynamic-id',tool:'mcp__mc__reply',arguments:{text}}});
const end={method:'turn/completed',params:{threadId:thread,turnId:'turn'}};
test('static reporting literals preserve spaces, Unicode escapes, tabs, and const references',()=>{
 const source='const answer="reporter 0.2.77; 465 тестов\\t42\\n"; text(await tools.mcp__mc__reply({text:answer,threadId:"private-id"}));';
 assert.equal(reportLiterals(source)[0].value,'reporter 0.2.77; 465 тестов\t42\n');
 assert.equal(reportLiterals('tools.mcp__mc__question({answer:"\\u041fроверено 42 теста"})')[0].value,'Проверено 42 теста');
});
test('never evaluates functions, expressions, interpolation or mutated identifiers',()=>{
 globalThis.probeExecuted=false;
 for(const source of ['tools.mcp__mc__reply({text:danger()})','tools.mcp__mc__reply({text:`value ${danger()}`})','const answer="safe"; answer=secret; tools.mcp__mc__reply({text:answer})','function f(){tools.mcp__mc__reply({text:"not actually executed"})}'])assert.deepEqual(reportLiterals(source),[]);
 assert.equal(globalThis.probeExecuted,false);delete globalThis.probeExecuted;
});
test('preserves exact source identity, detects deletion, exposes missing parent link',()=>{
 const rows=[],o=new ReportWhitespaceObserver(thread,x=>rows.push(x));
 const value='Проверено 465 тестов';const r=raw('tools.mcp__mc__reply({text:'+JSON.stringify(value)+'})');
 o.observe(r,'native-raw');o.observe(r,'forwarded-code-mode');o.observe(tool('Проверено465тестов'),'outgoing-report-tool');o.observe(end,'forwarded-code-mode');
 const c=rows.at(-1);assert.equal(c.rawToForwarded,'preserved');assert.equal(c.forwardedToTool,'changed');assert.match(c.toolCorrelation,/parent-call-ID-not-exposed/);
 assert.notEqual(rows[0].sha256,rows[2].sha256);
});
test('unchanged sampled boundaries compare preserved',()=>{
 const rows=[],o=new ReportWhitespaceObserver(thread,x=>rows.push(x)),r=raw('tools.mcp__mc__reply({text:"42 теста"})');
 o.observe(r,'native-raw');o.observe(r,'forwarded-code-mode');o.observe(tool('42 теста'),'outgoing-report-tool');o.observe(end,'forwarded-code-mode');assert.equal(rows.at(-1).forwardedToTool,'preserved');
});
test('does not guess a correlation when reports repeat or tool stage is absent',()=>{
 const rows=[],o=new ReportWhitespaceObserver(thread,x=>rows.push(x)),r=raw('tools.mcp__mc__reply({text:"first"});tools.mcp__mc__reply({text:"second"})');
 o.observe(r,'native-raw');o.observe(r,'forwarded-code-mode');o.observe(tool('second'),'outgoing-report-tool');o.observe(end,'forwarded-code-mode');assert.equal(rows.at(-1).rawToForwarded,'unobserved-or-ambiguous');assert.equal(rows.at(-1).forwardedToTool,'unobserved-or-ambiguous');
});
test('output excludes other threads, prompts, nonreporting tools, auth and all prose values',()=>{
 const secret='SECRET_DO_NOT_PERSIST',rows=[],o=new ReportWhitespaceObserver(thread,x=>rows.push(x));
 o.observe({...raw('tools.mcp__mc__reply({text:"42 теста"})'),params:{threadId:'foreign',item:{}}},'native-raw');
 o.observe({method:'rawResponseItem/completed',params:{threadId:thread,item:{type:'message',role:'user',content:[{text:secret}]}}},'native-raw');
 o.observe(raw('tools.exec_command({cmd:"'+secret+'"});tools.mcp__mc__reply({text:"42 теста",auth:"'+secret+'"})'),'native-raw');
 const serialized=JSON.stringify(rows);assert.equal(rows.length,1);assert.equal(serialized.includes(secret),false);assert.equal(serialized.includes('42 теста'),false);assert.equal(serialized.includes('cmd'),false);
 assert.deepEqual(rows[0].whitespace,[[2,32]]);
});
test('Unicode fingerprints use codepoint offsets, not split surrogate positions',()=>{
 assert.deepEqual(fingerprint('🙂 42\tтеста').whitespace,[[1,32],[4,9]]);
});
test('bounded source and unrelated tools remain unobserved',()=>{
 assert.deepEqual(reportLiterals(' '.repeat(1024*1024+1)),[]);
 const rows=[],o=new ReportWhitespaceObserver(thread,x=>rows.push(x));
 const other=tool('secret');other.params.tool='other-tool';o.observe(other,'outgoing-report-tool');
 // Oversize relevant values are excluded rather than partially fingerprinted.
 const oversized=tool('x'.repeat(1024*1024+1));o.observe(oversized,'outgoing-report-tool');
 assert.equal(rows.length,0);
});
