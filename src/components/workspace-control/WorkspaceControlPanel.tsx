import { useCallback, useEffect, useState } from 'react';
import { FolderHeart } from 'lucide-react';

import { authenticatedFetch } from '../../utils/api';
import { WORKSPACE_SERVICES } from '../../constants/providerPolicy';
import { Button, Dialog, DialogContent, DialogTitle, Input } from '../../shared/view/ui';

type Share = { id: string; owner: string; recipient: string; path: string; kind: string; access: string; status: string; error?: string };
type Snapshot = { id: string; created_at: string };
type Job = { id: string; kind: string; access: string; status: string; result?: string; error?: string };
type State = { shares: Share[]; snapshots: Snapshot[]; jobs: Job[] };

async function request(route: string, body?: object) {
  const response = await authenticatedFetch(`/api/workspace-control${route}`, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Workspace operation failed');
  return data;
}

export default function WorkspaceControlPanel() {
  const invitation = new URLSearchParams(window.location.search).get('workspaceShare') || sessionStorage.getItem('workspace-share-invitation');
  const [open, setOpen] = useState(Boolean(invitation));
  const [state, setState] = useState<State>({ shares: [], snapshots: [], jobs: [] });
  const [users, setUsers] = useState<string[]>([]);
  const [recipient, setRecipient] = useState('');
  const [folder, setFolder] = useState('');
  const [kind, setKind] = useState('folder');
  const [access, setAccess] = useState('read');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState('');
  const reload = useCallback(async () => {
    const [data, directory] = await Promise.all([request(''), request('/users')]);
    setState(data); setUsers(directory.users);
  }, []);
  useEffect(() => {
    if (!open || !WORKSPACE_SERVICES) return;
    void reload().catch(error => setMessage(error.message));
    const timer = setInterval(() => { void reload().catch(error => setMessage(error.message)); }, 5000);
    return () => clearInterval(timer);
  }, [open, reload]);
  const run = async (operation: () => Promise<void>) => {
    setBusy(true); setMessage('');
    try { await operation(); await reload(); } catch (error) { setMessage(error instanceof Error ? error.message : 'Operation failed'); }
    finally { setBusy(false); }
  };
  if (!WORKSPACE_SERVICES) return null;
  return <>
    <button className="flex w-full items-center gap-2 rounded-lg px-4 py-2 text-sm hover:bg-accent" onClick={() => setOpen(true)}><FolderHeart className="h-4 w-4" />Workspace sharing & recovery</button>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent aria-describedby={undefined} className="max-h-[85vh] w-[calc(100%_-_2rem)] max-w-2xl space-y-6 overflow-y-auto p-6"><div className="flex items-center justify-between gap-3"><DialogTitle className="not-sr-only text-lg font-semibold">Workspace sharing & recovery</DialogTitle><Button variant="ghost" onClick={() => setOpen(false)}>Close</Button></div>
      {message && <p role="status" className="text-sm text-amber-600">{message}</p>}
      {invitation && <section className="space-y-2 rounded border p-3"><p>You have a workspace invitation. Accept it to add the folder or skill to your workspace.</p><Button disabled={busy} onClick={() => void run(async () => { await request('/accept', { token: invitation }); sessionStorage.removeItem('workspace-share-invitation'); window.history.replaceState({}, '', window.location.pathname); setMessage('Invitation accepted. The shared folder will appear shortly.'); })}>Accept invitation</Button></section>}
      <section className="space-y-3"><h3 className="font-medium">Share a folder or skill</h3><p className="text-sm text-muted-foreground">Choose a user and send them the invitation link. Access lasts until you revoke it.</p>
        <select aria-label="Recipient" className="w-full rounded border bg-background p-2" value={recipient} onChange={event => setRecipient(event.target.value)}><option value="">Choose a VibeSpace user</option>{users.map(user => <option key={user}>{user}</option>)}</select>
        <select aria-label="Share type" className="w-full rounded border bg-background p-2" value={kind} onChange={event => setKind(event.target.value)}><option value="folder">Folder</option><option value="skill">Skill</option></select>
        <select aria-label="Access level" className="w-full rounded border bg-background p-2" value={access} onChange={event => setAccess(event.target.value)}><option value="read">Read-only</option><option value="write">Read and write</option></select>
        <Input value={folder} onChange={event => setFolder(event.target.value)} placeholder={kind === 'skill' ? 'skills/my-skill' : 'Folder inside your workspace, e.g. reports'} />
        <Button disabled={busy || !recipient || !folder} onClick={() => void run(async () => { const result = await request('/shares', { recipient, path: folder, kind, access }); setLink(new URL(result.invitation, window.location.origin).href); })}>Create invitation link</Button>
        {link && <div className="space-y-2"><Input readOnly value={link} aria-label="Invitation link" /><Button onClick={() => void navigator.clipboard.writeText(link)}>Copy link</Button></div>}
      </section>
      <section className="space-y-3 border-t pt-5"><h3 className="font-medium">Folder access</h3><p className="text-sm text-muted-foreground">Accepted folders appear in “Shared with me”. Revoking access also closes the recipient’s running workspace tools so they cannot retain access.</p>
        {!state.shares.some(share => share.status !== 'revoked') && <p className="text-sm">No shared folders yet.</p>}{state.shares.filter(share => share.status !== 'revoked').map(share => <div key={share.id} className="flex items-center justify-between gap-3 rounded border p-3"><div className="min-w-0 text-sm"><p className="break-all font-medium">{share.path}</p><p>{share.owner} → {share.recipient} · {share.access === 'write' ? 'read/write' : 'read-only'} · {share.status}</p>{share.error && <p>{share.error}</p>}</div>{!['revoked', 'revoking'].includes(share.status) && <Button disabled={busy} variant="outline" onClick={() => void run(async () => { await request(`/shares/${share.id}/revoke`, {}); })}>Revoke</Button>}</div>)}
      </section>
      <section className="space-y-3 border-t pt-5"><h3 className="font-medium">Recovery points</h3><p className="text-sm text-muted-foreground">Automatic backups run every 15 minutes. Recover creates a copy in the Recovered project; current files stay in place.</p><Button disabled={busy} onClick={() => void run(async () => { await request('/backups', {}); setMessage('Recovery point requested.'); })}>Back up now</Button>
        {state.jobs.filter(job => job.status !== 'done' || job.kind === 'restore').slice(0, 5).map(job => <p key={job.id} className="break-all text-sm">{job.kind}: {job.status}{job.result ? ` · ${job.result}` : ''}{job.error ? ` · ${job.error}` : ''}</p>)}
        {!state.snapshots.length && <p className="text-sm">Your first recovery point is being prepared.</p>}{state.snapshots.map(snapshot => <div className="flex items-center justify-between rounded border p-2" key={snapshot.id}><span className="text-sm">{new Date(snapshot.created_at).toLocaleString()}</span><Button variant="outline" disabled={busy} onClick={() => void run(async () => { await request('/backups', { snapshot: snapshot.id }); setMessage('Recovery requested. The recovered folder will appear shortly.'); })}>Recover</Button></div>)}
      </section>
    </DialogContent></Dialog>
  </>;
}
