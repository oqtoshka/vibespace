import { useEffect, useState } from 'react';
import { authenticatedFetch } from '../../../../../../../utils/api';

type Preferences = { permissionModes: string[]; defaultMode: string };
const labels: Record<string, string> = {
  default: 'Default', acceptEdits: 'Accept edits', bypassPermissions: 'Bypass permissions', plan: 'Plan',
};

export default function OpenCodePermissionsContent() {
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void authenticatedFetch('/api/settings/chat-permissions?provider=opencode')
      .then(async response => {
        if (!response.ok) throw new Error('Could not load permission preferences.');
        const data = await response.json() as Preferences;
        if (!cancelled) setPreferences(data);
      }).catch(err => { if (!cancelled) setError(String(err.message)); });
    return () => { cancelled = true; };
  }, []);
  const save = async (defaultMode: string) => {
    setSaving(true); setError('');
    try {
      const response = await authenticatedFetch('/api/settings/chat-permissions', {
        method: 'PUT', body: JSON.stringify({ provider: 'opencode', defaultMode }),
      });
      if (!response.ok) throw new Error('Could not save permission preferences.');
      setPreferences(await response.json() as Preferences);
      // The composer uses the same server preference when opening a session.
      localStorage.setItem('permissionMode-last-opencode', defaultMode);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setSaving(false); }
  };
  return <div className="space-y-4">
    <h3 className="text-lg font-medium text-foreground">Default permissions</h3>
    <p className="text-sm text-muted-foreground">Used for new sessions. Each session can choose its own permission mode.</p>
    {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
    {!preferences && !error && <p role="status">Loading permissions…</p>}
    {preferences && <label className="block space-y-2">
      <span className="text-sm">Permission mode</span>
      <select aria-label="Default permission mode" disabled={saving} value={preferences.defaultMode}
        onChange={event => void save(event.target.value)} className="block rounded-md border border-border bg-background px-3 py-2 text-foreground">
        {preferences.permissionModes.map(mode => <option key={mode} value={mode}>{labels[mode] ?? mode}</option>)}
      </select>
    </label>}
    {preferences?.defaultMode === 'bypassPermissions' && <p className="text-sm text-muted-foreground">Tools run without approval prompts. Questions that need your input still appear in the chat.</p>}
  </div>;
}
