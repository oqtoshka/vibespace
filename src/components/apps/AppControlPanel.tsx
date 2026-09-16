import { useCallback, useEffect, useState } from 'react';
import { Globe } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { authenticatedFetch } from '../../utils/api';
import { Button, Dialog, DialogContent, DialogTitle } from '../../shared/view/ui';

type App = { id: string; name: string; source: string; runtime: string; status: string; desired: string; generation: number; observed_generation: number; error?: string; revision?: string };
type State = { enabled: boolean; apps?: App[]; limits?: { apps: number; storageMiB: number } };

async function request(route = '', body?: object) {
  const response = await authenticatedFetch('/api/apps'+route, body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Application request failed');
  return result;
}

export default function AppControlPanel() {
  const { t } = useTranslation('common');
  const [state, setState] = useState<State | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', source: '', runtime: 'node', entrypoint: 'server.mjs' });
  const [share, setShare] = useState<{ id: string; url: string; shared: boolean } | null>(null);
  const [logs, setLogs] = useState<{ id: string; text: string } | null>(null);
  const reload = useCallback(async () => {
    const result = await request() as State; setState(result); return result;
  }, []);
  useEffect(() => {
    void reload().catch(() => {});
    if (!open) return;
    const timer = setInterval(() => { void reload().catch(error => setError(error.message)); }, 5000);
    return () => clearInterval(timer);
  }, [open, reload]);
  const act = async (operation: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await operation(); await reload(); } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  if (!state?.enabled) return null;
  return <>
    <button data-tour="workspace-apps" className="flex w-full items-center gap-2 rounded-lg px-4 py-2 text-sm hover:bg-accent" onClick={() => setOpen(true)}><Globe className="h-4 w-4"/>{t('apps.title', 'Web apps')}</button>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent aria-describedby={undefined} className="max-h-[85vh] w-[calc(100%_-_2rem)] max-w-3xl space-y-4 overflow-y-auto p-6">
      <div className="flex items-center justify-between"><DialogTitle className="not-sr-only text-lg font-semibold">{t('apps.title', 'Web apps')}</DialogTitle><Button variant="ghost" onClick={() => setOpen(false)}>{t('apps.close', 'Close')}</Button></div>
      <p className="text-sm text-muted-foreground">{t('apps.description', 'Small apps with persistent SQLite data. Access is private until you create a sharing link.')}</p>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <Button disabled={busy} onClick={() => setCreating(!creating)}>{t('apps.create', 'Deploy an app')}</Button>
      {creating && <form className="space-y-3 rounded-xl border p-4" onSubmit={event => { event.preventDefault(); void act(async () => { await request('', form); setCreating(false); }); }}>
        <p className="text-sm text-muted-foreground">{t('apps.runtimeHelp', 'Use a dedicated source folder. The app must listen on port 8080 and store SQLite in /data. This runtime provides Node or Python standard libraries.')}</p>
        {(['name', 'source', 'entrypoint'] as const).map(field => <label key={field} className="block text-sm">{t('apps.'+field, field)}<input required className="mt-1 block w-full rounded border bg-background p-2" value={form[field]} placeholder={field === 'source' ? 'projects/demo' : undefined} onChange={event => setForm({ ...form, [field]: event.target.value })}/></label>)}
        <label className="block text-sm">{t('apps.runtime', 'Runtime')}<select className="ml-3 rounded border bg-background p-2" value={form.runtime} onChange={event => setForm({ ...form, runtime: event.target.value, entrypoint: event.target.value === 'python' ? 'server.py' : 'server.mjs' })}><option value="node">Node</option><option value="python">Python</option></select></label>
        <Button type="submit" disabled={busy}>{t('apps.deploy', 'Deploy')}</Button>
      </form>}
      {!state.apps?.length && <p className="text-sm text-muted-foreground">{t('apps.empty', 'No deployed apps yet. Ask your agent to create and deploy a prototype.')}</p>}
      {state.apps?.map(app => {
        const pending = app.generation !== app.observed_generation;
        const disabled = busy || pending || app.desired === 'removed';
        const command = (action: string) => void act(async () => { await request(`/${app.id}/${action}`, {}); });
        return <section key={app.id} className="space-y-3 rounded-xl border p-4">
          <div className="flex flex-wrap justify-between gap-2"><h3 className="font-semibold">{app.name}</h3><span className="text-xs text-muted-foreground">{t('apps.status.'+app.status, app.status)}</span></div>
          <p className="break-all text-xs text-muted-foreground">{app.source} · {app.runtime}</p>
          {app.error && <p className="text-sm text-amber-600">{app.error}</p>}
          {app.desired === 'removed' ? <p className="text-sm">{t('apps.retained', 'App removed. Its database is retained; ask the administrator to restore or purge it.')}</p> : <div className="flex flex-wrap gap-2">
            <Button disabled={disabled || app.status !== 'running'} onClick={() => {
              const tab = window.open('about:blank', '_blank'); if (tab) tab.opener = null;
              void act(async () => { try { const grant = await request(`/${app.id}/open`, {}); if (tab) tab.location.href = grant.url; else setShare({ id: app.id, url: grant.url, shared: false }); } catch (error) { tab?.close(); throw error; } });
            }}>{t('apps.open', 'Open')}</Button>
            <Button variant="outline" disabled={disabled} onClick={() => command(app.desired === 'stopped' ? 'start' : 'stop')}>{app.desired === 'stopped' ? t('apps.start', 'Start') : t('apps.stop', 'Stop')}</Button>
            <Button variant="outline" disabled={disabled} onClick={() => command('redeploy')}>{t('apps.redeploy', 'Update from source')}</Button>
            <Button variant="outline" disabled={disabled || app.status !== 'running'} onClick={() => void act(async () => { const result = await request(`/${app.id}/share`, {}); setShare({ id: app.id, url: result.url, shared: true }); })}>{t('apps.share', 'Create sharing link')}</Button>
            <Button variant="outline" disabled={busy} onClick={() => void act(async () => { await request(`/${app.id}/revoke`, {}); setShare(null); })}>{t('apps.revoke', 'Revoke access links')}</Button>
            <Button variant="ghost" disabled={disabled} onClick={() => { if (window.confirm(t('apps.removeConfirm', 'Remove the app and revoke access? Its database will be retained.'))) command('remove'); }}>{t('apps.remove', 'Remove')}</Button>
          </div>}
          <Button variant="ghost" disabled={busy} onClick={() => void act(async () => { const result = await request(`/${app.id}/logs`); setLogs({ id: app.id, text: result.logs || t('apps.noLogs', 'No runtime logs yet.') }); })}>{t('apps.logs', 'Logs')}</Button>
          {logs?.id === app.id && <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-xs">{logs.text}</pre>}
          {share?.id === app.id && <div className="space-y-2"><p className="text-sm">{share.shared ? t('apps.linkHelp', 'Anyone holding a sharing link can open the app for seven days. Revoking access also closes existing sessions.') : t('apps.privateLinkHelp', 'Open this private link within one minute. It can be used once.')}</p><input aria-label={t('apps.link', 'Application link')} readOnly value={share.url} className="w-full rounded border bg-background p-2 text-xs" onFocus={event => event.target.select()}/><Button variant="outline" onClick={() => void act(async () => { await navigator.clipboard.writeText(share.url); })}>{t('apps.copy', 'Copy link')}</Button></div>}
        </section>;
      })}
    </DialogContent></Dialog>
  </>;
}
