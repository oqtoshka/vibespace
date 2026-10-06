import {createHash} from 'node:crypto';
import ts from 'typescript';

const fields = {
 reply:['text'], question:['question','answer'], propose:['title','observation','benefit','costs','text','description','what','why'],
 note:['text','title','note'], decide:['what','why','rejected'], state:['summary'], status:['note'],
};
const toolName = value => typeof value === 'string' ? value.replace(/^mcp__mc__/, '') : '';
export function fingerprint(value) {
 const chars=Array.from(value);
 return {sha256:createHash('sha256').update(value).digest('hex'),utf8Bytes:Buffer.byteLength(value),codePoints:chars.length,
  whitespace:chars.flatMap((c,i)=>/\s/u.test(c)?[[i,c.codePointAt(0)]]:[])};
}
function reportValues(tool,args) {
 const name=toolName(tool);return (fields[name]??[]).flatMap(field=>typeof args?.[field]==='string'?[{tool:name,field,value:args[field]}]:[]);
}
// Static syntax only; no eval, function invocation, property access, or interpolation.
export function reportLiterals(source) {
 if(source.length>1024*1024)return [];
 const file=ts.createSourceFile('native-code-mode.js',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
 if(file.parseDiagnostics.length)return [];
 const constants=new Map();
 for(const statement of file.statements) if(ts.isVariableStatement(statement) && statement.declarationList.flags & ts.NodeFlags.Const) {
  for(const d of statement.declarationList.declarations) if(ts.isIdentifier(d.name) && d.initializer && (ts.isStringLiteral(d.initializer)||ts.isNoSubstitutionTemplateLiteral(d.initializer)))constants.set(d.name.text,d.initializer.text);
 }
 const invalid=new Set();
 function assignments(n){if(ts.isBinaryExpression(n)&&n.operatorToken.kind>=ts.SyntaxKind.FirstAssignment&&n.operatorToken.kind<=ts.SyntaxKind.LastAssignment&&ts.isIdentifier(n.left))invalid.add(n.left.text);ts.forEachChild(n,assignments);}
 assignments(file);for(const name of invalid)constants.delete(name);
 const values=[];
 function string(n){return n&&(ts.isStringLiteral(n)||ts.isNoSubstitutionTemplateLiteral(n))?n.text:n&&ts.isIdentifier(n)?constants.get(n.text):undefined;}
 function visit(n){
  if(ts.isFunctionLike(n)||ts.isClassLike(n))return;
  if(ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&ts.isIdentifier(n.expression.expression)&&n.expression.expression.text==='tools'&&n.expression.name.text.startsWith('mcp__mc__')) {
   const args=n.arguments[0];if(args&&ts.isObjectLiteralExpression(args)) {
    const object={};for(const p of args.properties){
     if(ts.isPropertyAssignment(p)&&p.name&&(ts.isIdentifier(p.name)||ts.isStringLiteral(p.name)))object[p.name.text]=string(p.initializer);
     if(ts.isShorthandPropertyAssignment(p))object[p.name.text]=constants.get(p.name.text);
    }
    values.push(...reportValues(n.expression.name.text,object).map(v=>({...v,sourceStart:n.getStart(file),sourceEnd:n.end})));
   }
  }
  ts.forEachChild(n,visit);
 }
 visit(file);return values;
}
/** One native thread only. Records contain fingerprints/IDs/offsets, never prose/source. */
export class ReportWhitespaceObserver {
 constructor(threadId,emit){this.threadId=threadId;this.emit=emit;this.rows=new Map();}
 observe(message,stage){
  const p=message?.params;if(p?.threadId!==this.threadId)return;
  const item=p.item;
  let values=[],callId;
  if(stage!=='outgoing-report-tool'&&message.method==='rawResponseItem/completed'&&item?.type==='custom_tool_call'&&item.name==='exec'&&typeof item.input==='string') {
   values=reportLiterals(item.input);callId=item.call_id;
  }else if(stage==='outgoing-report-tool'&&message.method==='item/tool/call') {values=reportValues(p.tool,p.arguments);callId=p.callId;}
  else if(stage==='outgoing-report-tool'&&message.method==='item/started'&&item?.type==='mcpToolCall'&&item.server==='mc') {values=reportValues(item.tool,item.arguments);callId=item.id;}
  for(const {value,...where} of values){
   if(value.length>1024*1024||this.rows.size>=256)continue;
   const row={stage,threadId:p.threadId,turnId:p.turnId,callId,...where,...fingerprint(value)};
   this.emit(row);const key=JSON.stringify([p.turnId,where.tool,where.field]);const rows=this.rows.get(key)??[];if(rows.length<256)rows.push(row);this.rows.set(key,rows);
  }
  if(message.method==='turn/completed'&&stage==='forwarded-code-mode')this.finish(p.turnId);
 }
 finish(turnId){
  for(const [key,rows] of this.rows){
   if(rows[0]?.turnId!==turnId)continue;
   const raw=rows.filter(r=>r.stage==='native-raw'),forwarded=rows.filter(r=>r.stage==='forwarded-code-mode'),tool=rows.filter(r=>r.stage==='outgoing-report-tool');
   const r=raw.length===1?raw[0]:null,f=forwarded.length===1?forwarded[0]:null,t=tool.length===1?tool[0]:null;
   const exact=r&&f&&r.callId===f.callId;
   this.emit({type:'comparison',threadId:this.threadId,turnId,tool:rows[0].tool,field:rows[0].field,
    rawToForwarded:exact?(r.sha256===f.sha256?'preserved':'changed'):'unobserved-or-ambiguous',
    forwardedToTool:f&&t?(f.sha256===t.sha256?'preserved':'changed'):'unobserved-or-ambiguous',
    toolCorrelation:f&&t?'unique-thread-turn-report-tool-field; parent-call-ID-not-exposed':'not-observed',
    rawCallId:r?.callId,toolCallId:t?.callId});this.rows.delete(key);
  }
 }
}
