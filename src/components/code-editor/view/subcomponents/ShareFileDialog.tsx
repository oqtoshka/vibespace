import { Check, Copy, Link2, Loader2, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../../../utils/api';

type ShareFileDialogProps = {
  projectId: string;
  filePath: string;
  fileName: string;
  onClose: () => void;
};

type ShareRow = {
  shareId: string;
  createdAt: string;
  expiresAt: string | null;
  viewCount: number;
  lastAccessed: string | null;
};

type ExpiryOption = { value: '1h' | '1d' | '7d' | null; label: string };

const EXPIRY_OPTIONS: ExpiryOption[] = [
  { value: '1h', label: '1 hour' },
  { value: '1d', label: '1 day' },
  { value: '7d', label: '7 days' },
  { value: null, label: 'Permanent' },
];

const shareUrl = (shareId: string) => `${window.location.origin}/share/${shareId}`;

function formatExpiry(expiresAt: string | null): string {
  if (!expiresAt) return 'Permanent';
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return 'Permanent';
  if (date.getTime() <= Date.now()) return 'Expired';
  return `Expires ${date.toLocaleString()}`;
}

export default function ShareFileDialog({ projectId, filePath, fileName, onClose }: ShareFileDialogProps) {
  const [expiry, setExpiry] = useState<ExpiryOption['value']>(null);
  const [shares, setShares] = useState<ShareRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listShares(projectId, filePath);
      if (!res.ok) throw new Error(`Failed to load links (HTTP ${res.status})`);
      const data = await res.json();
      setShares(Array.isArray(data.shares) ? data.shares : []);
    } catch (e) {
      setError((e as Error).message || 'Failed to load links');
    } finally {
      setLoading(false);
    }
  }, [projectId, filePath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const handleCreate = async () => {
    setCreating(true);
    setError(null);
    try {
      const res = await api.createShare(projectId, { path: filePath, expiresIn: expiry });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `Failed to create link (HTTP ${res.status})`);
      }
      const data = await res.json();
      await refresh();
      if (data.shareId) await copyLink(data.shareId);
    } catch (e) {
      setError((e as Error).message || 'Failed to create link');
    } finally {
      setCreating(false);
    }
  };

  const copyLink = async (shareId: string) => {
    try {
      await navigator.clipboard.writeText(shareUrl(shareId));
      setCopiedId(shareId);
      setTimeout(() => setCopiedId((prev) => (prev === shareId ? null : prev)), 2000);
    } catch {
      // Clipboard can fail on insecure origins; surface the URL via prompt fallback.
      window.prompt('Copy this link:', shareUrl(shareId));
    }
  };

  const handleRevoke = async (shareId: string) => {
    setError(null);
    try {
      const res = await api.deleteShare(projectId, shareId);
      if (!res.ok) throw new Error(`Failed to revoke (HTTP ${res.status})`);
      setShares((prev) => prev.filter((s) => s.shareId !== shareId));
    } catch (e) {
      setError((e as Error).message || 'Failed to revoke link');
    }
  };

  return (
    <div
      className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-lg border border-border bg-popover shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <Link2 className="h-4 w-4 shrink-0 text-blue-500" />
            <h2 className="truncate text-sm font-semibold text-foreground">Share “{fileName}”</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-gray-500 hover:bg-accent hover:text-foreground"
            title="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-col gap-4 overflow-y-auto p-4">
          <p className="text-xs text-muted-foreground">
            Anyone with the link can view this file — no login required. The link serves the live
            file and stops working if the file is deleted.
          </p>

          <div className="flex items-end gap-2">
            <label className="flex flex-1 flex-col gap-1">
              <span className="text-xs font-medium text-foreground">Expires</span>
              <select
                value={expiry === null ? 'permanent' : expiry}
                onChange={(e) => setExpiry(e.target.value === 'permanent' ? null : (e.target.value as ExpiryOption['value']))}
                className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
              >
                {EXPIRY_OPTIONS.map((opt) => (
                  <option key={opt.label} value={opt.value === null ? 'permanent' : opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={handleCreate}
              disabled={creating}
              className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
              Create link
            </button>
          </div>

          {error && <div className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-900/20 dark:text-red-300">{error}</div>}

          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium text-foreground">Active links</span>
            {loading ? (
              <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
              </div>
            ) : shares.length === 0 ? (
              <div className="py-3 text-xs text-muted-foreground">No links yet.</div>
            ) : (
              <ul className="flex flex-col gap-2">
                {shares.map((share) => (
                  <li
                    key={share.shareId}
                    className="flex items-center gap-2 rounded-md border border-border bg-background px-2.5 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-mono text-xs text-foreground">{shareUrl(share.shareId)}</div>
                      <div className="mt-0.5 text-[11px] text-muted-foreground">
                        {formatExpiry(share.expiresAt)} · {share.viewCount} view{share.viewCount === 1 ? '' : 's'}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => copyLink(share.shareId)}
                      className="rounded-md p-1.5 text-gray-500 hover:bg-accent hover:text-foreground"
                      title="Copy link"
                    >
                      {copiedId === share.shareId ? (
                        <Check className="h-4 w-4 text-green-500" />
                      ) : (
                        <Copy className="h-4 w-4" />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRevoke(share.shareId)}
                      className="rounded-md p-1.5 text-gray-500 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20"
                      title="Revoke link"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
