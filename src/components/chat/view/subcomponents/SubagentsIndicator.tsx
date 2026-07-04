import { useEffect, useRef, useState } from 'react';
import { Bot, CheckCircle2, ChevronDown, Loader2, XCircle } from 'lucide-react';

import type { Subagent } from '../../hooks/useSubagents';
import SubagentConversationModal from './SubagentConversationModal';

type Props = {
  subagents: Subagent[];
  runningCount: number;
  sessionId: string | null;
};

function StatusIcon({ status }: { status: Subagent['status'] }) {
  if (status === 'running') return <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin text-blue-500" />;
  if (status === 'failed') return <XCircle className="h-3.5 w-3.5 flex-shrink-0 text-red-500" />;
  return <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0 text-green-500" />;
}

/**
 * Compact indicator (by the token counter) for subagents spawned this session.
 * Their conversations are kept out of the main thread — this opens each one as
 * its own read-only thread.
 */
export default function SubagentsIndicator({ subagents, runningCount, sessionId }: Props) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Subagent | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onClickOutside = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  if (subagents.length === 0) return null;

  const label = runningCount > 0 ? `${runningCount} running` : `${subagents.length} ${subagents.length === 1 ? 'agent' : 'agents'}`;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className={`flex items-center gap-1 rounded-md px-1.5 py-1 text-xs transition-colors hover:bg-accent ${
          runningCount > 0 ? 'text-blue-600 dark:text-blue-400' : 'text-muted-foreground'
        }`}
        title="Subagents"
      >
        {runningCount > 0 ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Bot className="h-3.5 w-3.5" />}
        <span className="hidden sm:inline">{label}</span>
        <span className="sm:hidden">{runningCount > 0 ? runningCount : subagents.length}</span>
        <ChevronDown className={`h-3 w-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute bottom-full right-0 z-50 mb-2 w-80 max-w-[85vw] overflow-hidden rounded-xl border border-border bg-card shadow-lg">
          <div className="border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">Subagents</div>
          <div className="max-h-80 overflow-y-auto">
            {subagents.map((subagent) => (
              <button
                key={subagent.key}
                type="button"
                onClick={() => {
                  setSelected(subagent);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
              >
                <StatusIcon status={subagent.status} />
                <span className="min-w-0 flex-1 truncate" title={subagent.label}>{subagent.label}</span>
                {subagent.subagentType && (
                  <span className="flex-shrink-0 truncate text-[10px] text-muted-foreground/70">{subagent.subagentType}</span>
                )}
                {subagent.toolCount > 0 && (
                  <span className="flex-shrink-0 text-[10px] tabular-nums text-muted-foreground/60">
                    {subagent.toolCount} {subagent.toolCount === 1 ? 'tool' : 'tools'}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {selected && sessionId && (
        <SubagentConversationModal
          sessionId={sessionId}
          subagent={selected}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
