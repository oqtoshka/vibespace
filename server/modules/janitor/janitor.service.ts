import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs, constants } from 'node:fs';

import { AppError } from '@/shared/index.js';
import { workspacePolicy } from '@/modules/workspace-policy/index.js';

type Candidate = {path:string;size:number;modified:number;hash:string;sample:string};
type Proposal = Omit<Candidate,'sample'> & {id:string;reason:string;sessionId?:string;status:'proposed'|'kept'|'moving'|'trashed'|'restored'|'stale';trashName?:string};
type State = {version:1;lastAttempt?:string;lastSuccess?:string;error?:string;running:boolean;unread:boolean;nightlyEnabled:boolean;proposals:Proposal[]};
type Options = {
  root:string;stateFile:string;
  active:()=>boolean;
  context:()=>Promise<unknown>;
  classify:(input:{files:Candidate[];sessions:unknown})=>Promise<unknown>;
  assertWritable?:(candidate:string)=>Promise<void>;
};
const emptyState = ():State=>({version:1,running:false,unread:false,nightlyEnabled:true,proposals:[]});
const MAX_FILE_BYTES=5*1024*1024;
const MIN_AGE_MS=48*60*60*1000;
const ignored = new Set(['node_modules','skills','local-skills','core-skills','core-memory','local-memory','memory','.vibespace-trash']);

/** Worker-scoped read-only analysis and user-approved recoverable moves.
 * Routes and the scheduled runner share one instance; tests inject model/session boundaries.
 */
export class Janitor {
  private serial:Promise<unknown>=Promise.resolve();
  private scanPromise:Promise<void>|null=null;
  private readonly root:string;
  private readonly guard:(candidate:string)=>Promise<void>;
  constructor(private readonly options:Options) {
    this.root=path.resolve(options.root);
    this.guard=options.assertWritable || (candidate=>workspacePolicy.assertWritable(candidate));
  }
  private async read():Promise<State> {
    let raw:string;
    try {raw=await fs.readFile(this.options.stateFile,'utf8');}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return emptyState();throw error;}
    const value=JSON.parse(raw) as State;
    if(value.version!==1||!Array.isArray(value.proposals))throw new Error('Invalid janitor state');
    if(value.running&&!this.scanPromise){value.running=false;value.error='Scan interrupted by server restart. Please retry.';}
    for(const item of value.proposals.filter(proposal=>proposal.status==='moving')){
      if(!item.trashName||!/^[a-f0-9-]{36}$/.test(item.trashName))throw new Error('Invalid trash manifest');
      const trash=await this.trashRoot();
      try {const stats=await fs.lstat(path.join(trash,item.trashName));if(!stats.isFile()||stats.isSymbolicLink())throw new Error('Invalid trash entry');item.status='trashed';}
      catch(error){
        if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
        try {await this.source(item.path);item.status='proposed';item.trashName=undefined;}
        catch(sourceError){if((sourceError as NodeJS.ErrnoException).code!=='ENOENT')throw sourceError;}
      }
    }
    return value;
  }
  private async save(value:State) {
    await fs.mkdir(path.dirname(this.options.stateFile),{recursive:true,mode:0o700});
    const temporary=this.options.stateFile+'.'+randomUUID()+'.tmp';
    try {await fs.writeFile(temporary,JSON.stringify(value),{mode:0o600,flag:'wx'});await fs.rename(temporary,this.options.stateFile);}
    finally {await fs.unlink(temporary).catch(()=>{});}
  }
  private async locked<T>(operation:()=>Promise<T>):Promise<T> {
    const result=this.serial.then(operation);
    this.serial=result.catch(()=>undefined);
    return result;
  }

  private requireIdle() {
    if(this.options.active())throw new AppError('A session is active. Review cleanup when it has finished.',{code:'JANITOR_ACTIVE_SESSION',statusCode:409});
  }
  private absolute(relative:string):string {
    if(typeof relative!=='string'||relative.split('/').some(part=>!part||part==='.'||part==='..')||path.isAbsolute(relative)||/[\\\x00-\x1f]/.test(relative))throw new Error('Invalid file path');
    return path.join(this.root,relative);
  }
  private async source(relative:string):Promise<string> {
    const candidate=this.absolute(relative);
    const rootReal=await fs.realpath(this.root);
    const real=await fs.realpath(candidate);
    if(real!==candidate && real!==path.join(rootReal,relative))throw new Error('Symlink paths are excluded');
    if(!real.startsWith(rootReal+path.sep))throw new Error('Path outside workspace');
    if((await fs.lstat(candidate)).isSymbolicLink())throw new Error('Symlink paths are excluded');
    return candidate;
  }
  private async fingerprint(candidate:string):Promise<{hash:string;size:number;modified:number;sample:string}> {
    const file=await fs.open(candidate,constants.O_RDONLY|constants.O_NOFOLLOW);
    try {
      const before=await file.stat();
      if(!before.isFile()||before.size>MAX_FILE_BYTES)throw new Error('Not an eligible regular file');
      const buffer=Buffer.alloc(before.size+1);
      const {bytesRead}=await file.read(buffer,0,buffer.length,0);
      const bytes=buffer.subarray(0,bytesRead);
      const after=await file.stat();
      if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||bytes.length!==after.size)throw new Error('File changed while reading');
      return {hash:createHash('sha256').update(bytes).digest('hex'),size:after.size,modified:after.mtimeMs,
        sample:/\.(txt|md|log|json|csv|py|js|mjs|sh|html)$/i.test(candidate)?bytes.subarray(0,1200).toString('utf8'):''};
    }finally{await file.close();}
  }
  private async inventory():Promise<Candidate[]> {
    const files:Candidate[]=[];let visited=0;let bytes=0;
    const policy=await workspacePolicy.read();
    const walk=async(directory:string,depth:number):Promise<void>=>{
      if(depth>6||files.length>=100||visited>=5000||bytes>=40*1024*1024)return;
      const handle=await fs.opendir(directory);
      for await(const entry of handle){
        if(files.length>=100||++visited>5000||bytes>=40*1024*1024)break;
        if(entry.name.startsWith('.')||ignored.has(entry.name)||/^(package(-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|AGENTS\.md|SOUL\.md|USER\.md|TOOLS\.md|MEMORY\.md|SECURITY\.md|HEARTBEAT\.md|IDENTITY\.md)$/i.test(entry.name)||/\.(sqlite3?|db|db3|p12|pfx)$/i.test(entry.name)||/(?:secret|credential|token|password|\.pem$|\.key$)/i.test(entry.name))continue;
        const candidate=path.join(directory,entry.name);
        const relative=path.relative(this.root,candidate).split(path.sep).join('/');
        if(policy?.rules.some(rule=>{const full=path.resolve(policy.root,rule.path);return rule.hidden&&(candidate===full||candidate.startsWith(full+path.sep));}))continue;
        if(entry.isDirectory()){await walk(candidate,depth+1);continue;}
        if(!entry.isFile())continue;
        try {
          const stats=await fs.lstat(candidate);
          if(stats.mtimeMs>Date.now()-MIN_AGE_MS||stats.size>MAX_FILE_BYTES)continue;
          await this.guard(candidate);
          const data=await this.fingerprint(await this.source(relative));
          if(data.modified>Date.now()-MIN_AGE_MS)continue;
          bytes+=data.size;files.push({path:relative,...data});
        }catch(error){if(error instanceof AppError&&error.code==='EACCES')continue;throw error;}
      }
    };
    await walk(this.root,0);return files;
  }
  async status() {return {...await this.read(),running:Boolean(this.scanPromise)};}
  async preferences(nightlyEnabled:boolean) {return this.locked(async()=>{const state=await this.read();state.nightlyEnabled=nightlyEnabled;await this.save(state);return this.status();});}
  async markRead() {return this.locked(async()=>{const state=await this.read();state.unread=false;await this.save(state);return this.status();});}
  async startScan() {
    return this.locked(async()=>{
    this.requireIdle();
    if(this.scanPromise)throw new AppError('Janitor is busy.',{code:'JANITOR_BUSY',statusCode:409});
    const state=await this.read();state.running=true;state.error=undefined;state.lastAttempt=new Date().toISOString();await this.save(state);
    this.scanPromise=this.scan().finally(()=>{this.scanPromise=null;});
    return {running:true};
    });
  }
  private async scan() {
    try {
      const files=await this.inventory();this.requireIdle();
      const sessions=files.length?await this.options.context():[];
      const output=files.length?await this.options.classify({files,sessions}):{proposals:[]};
      const rows=(output as {proposals?:unknown})?.proposals;
      if(!Array.isArray(rows))throw new Error('Model did not return a proposal list');
      const sessionIds=new Set(Array.isArray(sessions)?sessions.map(session=>session?.id).filter(id=>typeof id==='string'):[]);
      const byPath=new Map(files.map(file=>[file.path,file]));const used=new Set<string>();
      const proposals:Proposal[]=[];
      for(const row of rows.slice(0,50)){
        if(!row||typeof row.path!=='string'||typeof row.reason!=='string'||!row.reason.trim())continue;
        const file=byPath.get(row.path);if(!file||used.has(file.path))continue;used.add(file.path);
        const {sample:_sample,...identity}=file;
        proposals.push({...identity,id:randomUUID(),reason:row.reason.slice(0,2000),...(typeof row.sessionId==='string'&&sessionIds.has(row.sessionId)?{sessionId:row.sessionId}:{}),status:'proposed'});
      }
      await this.locked(async()=>{
        const state=await this.read();
        const retained=state.proposals.filter(item=>item.status!=='stale');
        const kept=new Set(retained.filter(item=>item.status==='kept').map(item=>`${item.path}:${item.hash}`));
        const existing=new Set(retained.filter(item=>item.status==='proposed').map(item=>`${item.path}:${item.hash}`));
        const fresh=proposals.filter(item=>!kept.has(`${item.path}:${item.hash}`)&&!existing.has(`${item.path}:${item.hash}`));
        state.proposals=[...retained,...fresh];state.running=false;state.lastSuccess=new Date().toISOString();state.unread=state.unread||fresh.length>0;state.error=undefined;await this.save(state);
      });
    }catch(error){
      // Failure is persisted for the inbox; never present a failed read as an empty workspace.
      try {await this.locked(async()=>{const state=await this.read();state.running=false;state.error=error instanceof AppError?error.message:'Scan failed. Files were not changed; retry or contact the administrator.';await this.save(state);});}
      catch {console.error('[janitor] Unable to persist scan failure');}
    }
  }
  async waitForScan() {await this.scanPromise;}
  async preview(id:string) {
    const proposal=(await this.read()).proposals.find(item=>item.id===id);
    if(!proposal)throw new AppError('Proposal not found.',{code:'NOT_FOUND',statusCode:404});
    const source=await this.source(proposal.path);
    const current=await this.fingerprint(source);
    return {path:proposal.path,content:current.sample,size:current.size,changed:current.hash!==proposal.hash};
  }
  private async trashRoot():Promise<string> {
    const directory=path.join(this.root,'.vibespace-trash');
    await fs.mkdir(directory,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});
    const stats=await fs.lstat(directory);
    if(!stats.isDirectory()||stats.isSymbolicLink()||await fs.realpath(directory)!==path.join(await fs.realpath(this.root),'.vibespace-trash'))throw new Error('Unsafe trash directory');
    return directory;
  }
  async decide(ids:string[],action:'keep'|'trash'|'restore') {
    return this.locked(async()=>{
      if(this.scanPromise)throw new AppError('Wait for the scan to finish.',{code:'JANITOR_BUSY',statusCode:409});
      this.requireIdle();
      const state=await this.read();const results:Array<{id:string;ok:boolean;error?:string}>=[];
      for(const id of ids){
        const proposal=state.proposals.find(item=>item.id===id);
        if(!proposal){results.push({id,ok:false,error:'Proposal not found'});continue;}
        try {
          this.requireIdle();
          if(action==='keep'&&proposal.status==='proposed'){proposal.status='kept';}
          else if(action==='trash'&&proposal.status==='proposed'){
            const source=await this.source(proposal.path);await this.guard(source);
            const current=await this.fingerprint(source);
            if(current.hash!==proposal.hash||current.modified!==proposal.modified||current.size!==proposal.size){proposal.status='stale';throw new Error('File changed since the scan; scan again');}
            const trash=await this.trashRoot();proposal.trashName=randomUUID();proposal.status='moving';await this.save(state);
            await fs.rename(source,path.join(trash,proposal.trashName));proposal.status='trashed';
          }else if(action==='restore'&&(proposal.status==='trashed'||proposal.status==='moving')){
            if(!proposal.trashName||!/^[a-f0-9-]{36}$/.test(proposal.trashName))throw new Error('Invalid trash item');
            const trash=await this.trashRoot();const from=path.join(trash,proposal.trashName);
            const stat=await fs.lstat(from);if(!stat.isFile()||stat.isSymbolicLink())throw new Error('Trash item unavailable');
            const target=this.absolute(proposal.path);
            const parent=await fs.realpath(path.dirname(target));
            if(parent!==path.dirname(path.join(await fs.realpath(this.root),proposal.path)))throw new Error('Original parent changed; restore manually');
            await this.guard(target);
            // link is atomic and refuses an existing destination, preserving new user work.
            await fs.link(from,target);await fs.unlink(from);proposal.status='restored';
          }else throw new Error('This action no longer applies');
          results.push({id,ok:true});
        }catch(error){results.push({id,ok:false,error:error instanceof Error?error.message:String(error)});}
        await this.save(state);
      }
      state.unread=false;await this.save(state);return {results,state:await this.status()};
    });
  }
}
