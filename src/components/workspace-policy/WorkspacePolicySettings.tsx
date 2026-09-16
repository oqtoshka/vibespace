import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '../../utils/api';

type Rule = {path:string; hidden?:boolean; readOnly?:boolean; displayName?:string; description?:string};
type Snapshot = {policy:{root:string;rules:Rule[]}; revision:string};

export default function WorkspacePolicySettings() {
  const {t} = useTranslation('settings');
  const [snapshot,setSnapshot] = useState<Snapshot | null>(null);
  const [rules,setRules] = useState<Rule[]>([]);
  const [busy,setBusy] = useState(false);
  const [message,setMessage] = useState('');
  useEffect(() => {
    let active=true;
    void api.get('/workspace-policy/admin').then(async response => {
      if (!response.ok) return;
      const value = await response.json();
      if (active && value?.policy && Array.isArray(value.policy.rules)) {setSnapshot(value);setRules(value.policy.rules);}
    }).catch(() => {});
    return () => {active=false;};
  },[]);
  if (!snapshot) return null;
  const update = (index:number,change:Partial<Rule>) => setRules(previous=>previous.map((rule,i)=>i===index?{...rule,...change}:rule));
  const save = async () => {
    setBusy(true);setMessage('');
    try {
      const response=await api.put('/workspace-policy/admin',{rules,revision:snapshot.revision});
      const value=await response.json();
      if (!response.ok) throw new Error(value.error || 'Unable to save');
      setSnapshot(value);setRules(value.policy.rules);
      setMessage(t('workspacePolicy.saved','Workspace rules saved.'));
      window.dispatchEvent(new Event('focus'));
    } catch(error) {setMessage(error instanceof Error ? error.message : String(error));}
    finally {setBusy(false);}
  };
  return <section className="space-y-4 rounded-lg border border-border p-4">
    <h3 className="font-semibold">{t('workspacePolicy.title','Workspace administration')}</h3>
    <p className="text-sm text-muted-foreground">{t('workspacePolicy.description','Rules apply to every workspace in this deployment. Display names do not rename files. Read-only protection also covers nested files and API operations.')}</p>
    <div className="space-y-4">
      {rules.map((rule,index)=><fieldset key={index} disabled={busy} className="space-y-2 rounded-lg border border-border p-3">
        <label className="block text-sm">{t('workspacePolicy.path','Path relative to workspace')}
          <input className="mt-1 w-full rounded border border-input bg-background p-2" value={rule.path} onChange={event=>update(index,{path:event.target.value})} placeholder="system/skills" />
        </label>
        <label className="block text-sm">{t('workspacePolicy.name','Display name')}
          <input className="mt-1 w-full rounded border border-input bg-background p-2" value={rule.displayName || ''} onChange={event=>update(index,{displayName:event.target.value})}/>
        </label>
        <label className="block text-sm">{t('workspacePolicy.tooltip','Description / tooltip')}
          <input className="mt-1 w-full rounded border border-input bg-background p-2" value={rule.description || ''} onChange={event=>update(index,{description:event.target.value})}/>
        </label>
        <div className="flex flex-wrap gap-4 text-sm">
          <label><input type="checkbox" checked={rule.hidden===true} onChange={event=>update(index,{hidden:event.target.checked})}/> {t('workspacePolicy.hidden','Hidden by default')}</label>
          <label><input type="checkbox" checked={rule.readOnly===true} onChange={event=>update(index,{readOnly:event.target.checked})}/> {t('workspacePolicy.readOnly','Read-only')}</label>
          <button type="button" onClick={()=>setRules(previous=>previous.filter((_,i)=>i!==index))}>{t('workspacePolicy.remove','Remove rule')}</button>
        </div>
      </fieldset>)}
    </div>
    <div className="flex gap-3">
      <button type="button" disabled={busy} className="rounded border border-border px-3 py-2" onClick={()=>setRules(previous=>[...previous,{path:''}])}>{t('workspacePolicy.add','Add rule')}</button>
      <button type="button" disabled={busy} className="rounded bg-primary px-3 py-2 text-primary-foreground" onClick={()=>void save()}>{t('workspacePolicy.save','Save rules')}</button>
      <button type="button" disabled={busy} className="rounded border border-border px-3 py-2" onClick={async()=>{
        try {const response=await api.get('/workspace-policy/admin');const value=await response.json();if(!response.ok)throw new Error(value.error);setSnapshot(value);setRules(value.policy.rules);setMessage('');}
        catch(error){setMessage(String(error));}
      }}>{t('workspacePolicy.reload','Reload')}</button>
    </div>
    {message && <p role="status" className="text-sm">{message}</p>}
  </section>;
}
