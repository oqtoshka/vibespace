import { useCallback, useEffect, useState } from 'react';
import { Brush } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { authenticatedFetch } from '../../utils/api';
import { Button, Dialog, DialogContent, DialogTitle } from '../../shared/view/ui';

type Proposal={id:string;path:string;size:number;modified:number;reason:string;sessionId?:string;status:string};
type State={enabled:boolean;running:boolean;unread:boolean;nightlyEnabled:boolean;lastSuccess?:string;error?:string;proposals:Proposal[]};
async function request(route='',body?:object){
  const response=await authenticatedFetch(`/api/janitor${route}`,body===undefined?{}:{method:'POST',body:JSON.stringify(body)});
  const data=await response.json();if(!response.ok)throw new Error(data.error||'Janitor unavailable');return data;
}

export default function JanitorInbox(){
  const {t}=useTranslation('common');
  const [open,setOpen]=useState(false);
  const [state,setState]=useState<State|null>(null);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const [selected,setSelected]=useState<Set<string>>(new Set());
  const [preview,setPreview]=useState<{path:string;content:string;changed:boolean}|null>(null);
  const reload=useCallback(async()=>{
    try{const value=await request();setState(value);setError('');return value as State;}
    catch(error){setError(error instanceof Error?error.message:String(error));return null;}
  },[]);
  useEffect(()=>{void reload();const timer=setInterval(()=>void reload(),open?5000:60000);return()=>clearInterval(timer);},[open,reload]);
  const run=async(action:()=>Promise<unknown>,clearSelection=false)=>{
    setBusy(true);setError('');
    try{const result=await action() as {results?:Array<{ok:boolean;error?:string}>};await reload();
      const failures=result?.results?.filter(row=>!row.ok)||[];
      if(failures.length)setError(failures.map(row=>row.error).join('\n'));
      if(clearSelection)setSelected(new Set());
    }catch(error){setError(error instanceof Error?error.message:String(error));}
    finally{setBusy(false);}
  };
  if(state?.enabled===false)return null;
  const proposals=state?.proposals?.filter(item=>item.status==='proposed')||[];
  const trash=state?.proposals?.filter(item=>['trashed','moving'].includes(item.status))||[];
  const chosen=[...selected].filter(id=>proposals.some(item=>item.id===id));
  return <>
    <button className="flex w-full items-center gap-2 rounded-lg px-4 py-2 text-sm hover:bg-accent" onClick={()=>{
      setOpen(true);void reload().then(value=>{if(value?.enabled)void request('/read',{}).then(()=>reload()).catch(()=>{});});
    }}><Brush className="h-4 w-4"/>{t('janitor.title','Janitor')}
      {state?.unread&&<span className="ml-auto rounded-full bg-primary px-2 text-primary-foreground" aria-label={t('janitor.unread','New cleanup suggestions')}>{proposals.length}</span>}
      {!state&&error&&<span>!</span>}
    </button>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent aria-describedby={undefined} className="max-h-[85vh] w-[calc(100%_-_2rem)] max-w-3xl space-y-4 overflow-y-auto p-6">
      <div className="flex items-center justify-between"><DialogTitle className="not-sr-only text-lg font-semibold">{t('janitor.title','Janitor')}</DialogTitle><Button variant="ghost" onClick={()=>setOpen(false)}>{t('janitor.close','Close')}</Button></div>
      <p className="text-sm text-muted-foreground">{t('janitor.description','Suggestions only. Nothing is removed without your selection. Review the reason and preview before moving files to recoverable trash.')}</p>
      {(error||state?.error)&&<p role="status" className="whitespace-pre-wrap text-sm text-amber-600">{error||state?.error}</p>}
      <div className="flex flex-wrap items-center gap-4">
        <Button disabled={busy||state?.running||!state?.enabled} onClick={()=>void run(()=>request('/scan',{}))}>{state?.running?t('janitor.scanning','Scanning…'):t('janitor.scan','Scan workspace')}</Button>
        <label className="text-sm"><input type="checkbox" checked={state?.nightlyEnabled===true} disabled={busy||!state?.enabled} onChange={event=>{const nightlyEnabled=event.target.checked;const previous=state;if(state)setState({...state,nightlyEnabled});void run(async()=>{try{return await request('/preferences',{nightlyEnabled});}catch(error){setState(previous);throw error;}});}}/> {t('janitor.nightly','Nightly scan')}</label>
      </div>
      <p className="text-xs text-muted-foreground">{t('janitor.limits','Each scan reviews up to 100 eligible files older than 48 hours and samples up to five inactive sessions. Private sessions, managed files and personal memory are excluded.')}</p>
      {state?.lastSuccess&&<p className="text-xs">{t('janitor.lastScan','Last successful scan')}: {new Date(state.lastSuccess).toLocaleString()}</p>}
      <section className="space-y-3">
        <h3 className="font-medium">{t('janitor.suggestions','Cleanup suggestions')} ({proposals.length})</h3>
        {!proposals.length&&<p className="text-sm">{t('janitor.empty','No pending suggestions. This does not mean the entire workspace has been checked.')}</p>}
        {proposals.map(item=><div key={item.id} className="rounded border border-border p-3">
          <label className="flex items-start gap-2"><input type="checkbox" checked={selected.has(item.id)} disabled={busy||state?.running} onChange={event=>setSelected(previous=>{const next=new Set(previous);if(event.target.checked)next.add(item.id);else next.delete(item.id);return next;})}/><span className="break-all text-sm font-medium">{item.path}</span></label>
          <p className="mt-2 text-sm">{item.reason}</p><p className="text-xs text-muted-foreground">{(item.size/1024).toFixed(1)} KB · {new Date(item.modified).toLocaleString()}</p>
          <div className="mt-2 flex gap-3"><Button size="sm" variant="outline" onClick={()=>void run(async()=>{setPreview(await request(`/preview/${encodeURIComponent(item.id)}`));})}>{t('janitor.preview','Preview')}</Button>
          {item.sessionId&&<a className="text-sm underline" href={`/session/${encodeURIComponent(item.sessionId)}`}>{t('janitor.session','Related session')}</a>}</div>
        </div>)}
        <div className="flex gap-3"><Button disabled={busy||state?.running||!chosen.length} onClick={()=>void run(()=>request('/trash',{ids:chosen}),true)}>{t('janitor.trashSelected','Move selected to trash')} ({chosen.length})</Button><Button variant="outline" disabled={busy||state?.running||!chosen.length} onClick={()=>void run(()=>request('/keep',{ids:chosen}),true)}>{t('janitor.keep','Keep selected')}</Button></div>
      </section>
      {preview&&<section className="rounded border border-border p-3"><h3 className="break-all font-medium">{preview.path}</h3>{preview.changed&&<p>{t('janitor.changed','File changed since the scan. Scan again before cleanup.')}</p>}<p className="text-xs text-muted-foreground">{t('janitor.previewLimit','First 1,200 bytes of a text file. Review the original file for full context.')}</p><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-xs">{preview.content||t('janitor.noPreview','No text preview is available.')}</pre></section>}
      <section className="space-y-2 border-t border-border pt-4"><h3 className="font-medium">{t('janitor.trash','Recoverable trash')} ({trash.length})</h3><p className="text-xs text-muted-foreground">{t('janitor.retention','Trash is not purged automatically. Restore never overwrites an existing file.')}</p>
        {trash.map(item=><div key={item.id} className="flex items-center justify-between gap-3 rounded border border-border p-2"><span className="break-all text-sm">{item.path}</span><Button disabled={busy||state?.running} variant="outline" onClick={()=>void run(()=>request('/restore',{ids:[item.id]}))}>{t('janitor.restore','Restore')}</Button></div>)}
      </section>
    </DialogContent></Dialog>
  </>;
}
