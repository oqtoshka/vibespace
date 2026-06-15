import { Check, ChevronDown, GitBranchPlus, Trash2, TreePine } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { GitWorktree } from '../types/types';

type WorktreePickerProps = {
  isMobile: boolean;
  worktrees: GitWorktree[];
  /** Local branch names — used to populate the "existing branch" option. */
  branches: string[];
  activeWorktreePath: string | null;
  onSelect: (worktree: GitWorktree | null) => void;
  onAdd: (opts: { branch: string; createBranch: boolean; base?: string | null }) => Promise<boolean>;
  onRemove: (worktreePath: string) => Promise<boolean>;
};

function worktreeLabel(worktree: GitWorktree): string {
  if (worktree.branch) return worktree.branch;
  if (worktree.detached) return worktree.head ? `detached @ ${worktree.head.slice(0, 7)}` : 'detached';
  return worktree.path.split('/').pop() || worktree.path;
}

/**
 * Dropdown for managing git worktrees. Selecting one sets the project's active
 * worktree — where new chat sessions run. The main checkout means "no worktree".
 */
export default function WorktreePicker({
  isMobile,
  worktrees,
  branches,
  activeWorktreePath,
  onSelect,
  onAdd,
  onRemove,
}: WorktreePickerProps) {
  const [showDropdown, setShowDropdown] = useState(false);
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [newBranch, setNewBranch] = useState('');
  const [existingBranch, setExistingBranch] = useState('');
  const [creating, setCreating] = useState(false);
  const dropdownRef = useRef<HTMLDivElement | null>(null);

  // A branch can be checked out in only one worktree, so exclude branches
  // already attached to a worktree from the "existing" option.
  const checkedOut = new Set(worktrees.map((w) => w.branch).filter(Boolean) as string[]);
  const availableExisting = branches.filter((b) => !checkedOut.has(b));

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const active = worktrees.find((w) => w.path === activeWorktreePath) ?? null;
  const buttonLabel = active ? worktreeLabel(active) : 'main checkout';

  const handleCreate = async () => {
    const branch = mode === 'new' ? newBranch.trim() : existingBranch;
    if (!branch || creating) return;
    setCreating(true);
    const ok = await onAdd({
      branch,
      createBranch: mode === 'new',
      base: mode === 'new' ? 'HEAD' : null,
    });
    setCreating(false);
    if (ok) {
      setNewBranch('');
      setExistingBranch('');
      setShowDropdown(false);
    }
  };

  return (
    <div className={`flex items-center border-b border-border/60 ${isMobile ? 'px-3 py-1.5' : 'px-4 py-2'}`}>
      <div className="relative" ref={dropdownRef}>
        <button
          onClick={() => setShowDropdown((prev) => !prev)}
          className={`flex items-center rounded-lg transition-colors hover:bg-accent ${isMobile ? 'space-x-1 px-2 py-1' : 'space-x-2 px-3 py-1.5'}`}
          title="Worktree for new sessions"
        >
          <TreePine className={`text-muted-foreground ${isMobile ? 'h-3 w-3' : 'h-4 w-4'}`} />
          <span className={`font-medium ${isMobile ? 'text-xs' : 'text-sm'}`}>{buttonLabel}</span>
          <ChevronDown className={`h-3 w-3 text-muted-foreground transition-transform ${showDropdown ? 'rotate-180' : ''}`} />
        </button>

        {showDropdown && (
          <div className="absolute left-0 top-full z-50 mt-1 w-72 overflow-hidden rounded-xl border border-border bg-card shadow-lg">
            <div className="max-h-64 overflow-y-auto py-1">
              {worktrees.map((worktree) => {
                const isActive = worktree.isMain ? activeWorktreePath === null : worktree.path === activeWorktreePath;
                return (
                  <div
                    key={worktree.path}
                    className={`group flex items-center justify-between px-3 py-2 text-sm transition-colors hover:bg-accent ${
                      isActive ? 'bg-accent/50 text-foreground' : 'text-muted-foreground'
                    }`}
                  >
                    <button
                      onClick={() => {
                        onSelect(worktree);
                        setShowDropdown(false);
                      }}
                      className="flex min-w-0 flex-1 items-center space-x-2 text-left"
                    >
                      {isActive ? <Check className="h-3 w-3 flex-shrink-0 text-primary" /> : <span className="w-3 flex-shrink-0" />}
                      <span className={`truncate ${isActive ? 'font-medium' : ''}`}>{worktreeLabel(worktree)}</span>
                      {worktree.isMain && <span className="flex-shrink-0 text-xs text-muted-foreground">(main)</span>}
                    </button>
                    {!worktree.isMain && (
                      <button
                        onClick={() => {
                          void onRemove(worktree.path);
                        }}
                        className="ml-2 flex-shrink-0 rounded p-1 text-muted-foreground opacity-0 transition hover:bg-red-500/10 hover:text-red-500 group-hover:opacity-100"
                        title="Remove worktree"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="space-y-1.5 border-t border-border p-2">
              {/* New branch (from HEAD) vs an existing branch. */}
              <div className="flex items-center gap-1 rounded-md bg-muted/50 p-0.5 text-[11px]">
                {(['new', 'existing'] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setMode(m)}
                    className={`flex-1 rounded px-2 py-1 font-medium transition ${
                      mode === m ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {m === 'new' ? 'New branch' : 'Existing branch'}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-1.5">
                <GitBranchPlus className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                {mode === 'new' ? (
                  <input
                    type="text"
                    value={newBranch}
                    onChange={(e) => setNewBranch(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void handleCreate();
                    }}
                    placeholder="new-branch-name"
                    className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary/40"
                  />
                ) : (
                  <select
                    value={existingBranch}
                    onChange={(e) => setExistingBranch(e.target.value)}
                    className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary/40"
                  >
                    <option value="">
                      {availableExisting.length ? 'Select branch…' : 'No available branches'}
                    </option>
                    {availableExisting.map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))}
                  </select>
                )}
                <button
                  onClick={() => void handleCreate()}
                  disabled={(mode === 'new' ? !newBranch.trim() : !existingBranch) || creating}
                  className="h-7 flex-shrink-0 rounded-md bg-primary px-2 text-xs font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50"
                >
                  {creating ? '…' : 'Create'}
                </button>
              </div>
              <p className="px-0.5 text-[11px] text-muted-foreground">
                {mode === 'new'
                  ? 'New branch from HEAD, checked out in a worktree. New sessions run there.'
                  : 'Checks out the chosen branch in a worktree. New sessions run there.'}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
