import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, ChevronDown, Loader2, Terminal, X, XCircle } from 'lucide-react';
import { api } from '../../../../utils/api';
import { useBackgroundTasksContext } from '../../context/BackgroundTasksContext';
import type { BackgroundTask } from '../../hooks/useBackgroundTasks';
import { AnchoredPopover } from './AnchoredPopover';

type BackgroundTasksIndicatorProps = {
  tasks: BackgroundTask[];
  runningCount: number;
};

const OUTPUT_POLL_MS = 2000;

function StatusIcon({ status }: { status: BackgroundTask['status'] }) {
  if (status === 'running') return <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin text-blue-500" />;
  if (status === 'failed') return <XCircle className="h-3.5 w-3.5 flex-shrink-0 text-red-500" />;
  if (status === 'ended') return <Terminal className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />;
  return <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0 text-green-500" />;
}

/**
 * Compact indicator (sits by the token counter) showing background bash tasks
 * launched in this session — how many are running, and a popover to inspect
 * each one's status, stream its live output, and cancel it.
 */
export default function BackgroundTasksIndicator({ tasks, runningCount }: BackgroundTasksIndicatorProps) {
  const ctx = useBackgroundTasksContext();
  const [open, setOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [output, setOutput] = useState<{ id: string; text: string; loading: boolean; error?: string } | null>(null);
  const anchorRef = useRef<HTMLButtonElement | null>(null);

  const expandedTask = expandedId ? tasks.find((task) => task.id === expandedId) ?? null : null;
  const expandedRunning = expandedTask?.status === 'running';
  const expandedOutputFile = expandedTask?.outputFile ?? null;

  // Stream the expanded task's output; poll while it runs, fetch once when done.
  useEffect(() => {
    if (!expandedId || !expandedOutputFile) return;
    let cancelled = false;
    let controller: AbortController | null = null;

    const fetchOnce = async (showSpinner: boolean) => {
      if (showSpinner) setOutput((prev) => (prev && prev.id === expandedId && prev.text ? prev : { id: expandedId, text: '', loading: true }));
      controller?.abort();
      controller = new AbortController();
      try {
        const res = await api.taskOutput(expandedOutputFile, { signal: controller.signal });
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setOutput({ id: expandedId, text: '', loading: false, error: data?.error || 'Failed to read output' });
          return;
        }
        setOutput({ id: expandedId, text: data.content || '(no output yet)', loading: false });
      } catch (error) {
        if (cancelled || (error as Error)?.name === 'AbortError') return;
        setOutput({ id: expandedId, text: '', loading: false, error: (error as Error)?.message || 'Failed to read output' });
      }
    };

    void fetchOnce(true);
    const timer = expandedRunning ? window.setInterval(() => void fetchOnce(false), OUTPUT_POLL_MS) : null;
    return () => {
      cancelled = true;
      controller?.abort();
      if (timer) window.clearInterval(timer);
    };
  }, [expandedId, expandedOutputFile, expandedRunning]);

  const toggleExpand = (task: BackgroundTask) => {
    if (expandedId === task.id) {
      setExpandedId(null);
      setOutput(null);
      return;
    }
    setExpandedId(task.id);
    if (!task.outputFile) {
      setOutput({ id: task.id, text: '', loading: false, error: 'No output file' });
    }
  };

  if (tasks.length === 0) return null;

  const label = runningCount > 0 ? `${runningCount} running` : `${tasks.length} done`;
  const canCancel = Boolean(ctx?.canCancel);

  return (
    <div className="relative">
      <button
        ref={anchorRef}
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className={`flex items-center gap-1 rounded-md px-1.5 py-1 text-xs transition-colors hover:bg-accent ${
          runningCount > 0 ? 'text-blue-600 dark:text-blue-400' : 'text-muted-foreground'
        }`}
        title="Background tasks"
      >
        {runningCount > 0 ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Terminal className="h-3.5 w-3.5" />}
        <span className="hidden sm:inline">{label}</span>
        <span className="sm:hidden">{runningCount > 0 ? runningCount : tasks.length}</span>
        <ChevronDown className={`h-3 w-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      <AnchoredPopover
        anchorRef={anchorRef}
        open={open}
        onClose={() => setOpen(false)}
        className="w-80 max-w-[85vw] overflow-hidden rounded-xl border border-border bg-card shadow-lg"
      >
        <div className="border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">
          Background tasks
        </div>
        <div className="max-h-80 overflow-y-auto">
            {tasks.map((task) => (
              <div key={task.id} className="border-b border-border/50 last:border-b-0">
                <div className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent">
                  <button
                    type="button"
                    onClick={() => toggleExpand(task)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <StatusIcon status={task.status} />
                    <span className="min-w-0 flex-1 truncate" title={task.label}>{task.label}</span>
                    {task.status === 'failed' && task.exitCode !== null && (
                      <span className="flex-shrink-0 text-xs text-red-500">exit {task.exitCode}</span>
                    )}
                  </button>
                  {task.status === 'running' && canCancel && (
                    <button
                      type="button"
                      onClick={() => ctx?.cancelTask(task.id)}
                      className="flex flex-shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground/70 transition-colors hover:bg-red-500/10 hover:text-red-600 dark:hover:text-red-400"
                      title="Cancel this background job"
                    >
                      <X className="h-3 w-3" /> cancel
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => toggleExpand(task)}
                    className="flex-shrink-0"
                    aria-label="Toggle output"
                  >
                    <ChevronDown
                      className={`h-3 w-3 flex-shrink-0 text-muted-foreground transition-transform ${expandedId === task.id ? 'rotate-180' : ''}`}
                    />
                  </button>
                </div>
                {expandedId === task.id && (
                  <div className="bg-muted/40 px-3 py-2">
                    {output && output.id === task.id && output.loading ? (
                      <div className="text-xs text-muted-foreground">Loading output…</div>
                    ) : output && output.id === task.id && output.error ? (
                      <div className="text-xs text-red-500">{output.error}</div>
                    ) : (
                      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground/80">
                        {output && output.id === task.id ? output.text : ''}
                      </pre>
                    )}
                  </div>
                )}
              </div>
            ))}
        </div>
      </AnchoredPopover>
    </div>
  );
}
