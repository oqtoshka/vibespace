import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, ChevronDown, Loader2, Terminal, XCircle } from 'lucide-react';
import { api } from '../../../../utils/api';
import type { BackgroundTask } from '../../hooks/useBackgroundTasks';

type BackgroundTasksIndicatorProps = {
  tasks: BackgroundTask[];
  runningCount: number;
};

function StatusIcon({ status }: { status: BackgroundTask['status'] }) {
  if (status === 'running') return <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin text-blue-500" />;
  if (status === 'failed') return <XCircle className="h-3.5 w-3.5 flex-shrink-0 text-red-500" />;
  if (status === 'ended') return <Terminal className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />;
  return <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0 text-green-500" />;
}

/**
 * Compact indicator (sits by the token counter) showing background bash tasks
 * launched in this session — how many are running, and a popover to inspect
 * each one's status and live output.
 */
export default function BackgroundTasksIndicator({ tasks, runningCount }: BackgroundTasksIndicatorProps) {
  const [open, setOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [output, setOutput] = useState<{ id: string; text: string; loading: boolean; error?: string } | null>(null);
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

  const viewOutput = async (task: BackgroundTask) => {
    if (expandedId === task.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(task.id);
    if (!task.outputFile) {
      setOutput({ id: task.id, text: '', loading: false, error: 'No output file' });
      return;
    }
    setOutput({ id: task.id, text: '', loading: true });
    try {
      const response = await api.taskOutput(task.outputFile);
      const data = await response.json();
      if (!response.ok) {
        setOutput({ id: task.id, text: '', loading: false, error: data?.error || 'Failed to read output' });
        return;
      }
      setOutput({ id: task.id, text: data.content || '(empty)', loading: false });
    } catch (error) {
      setOutput({ id: task.id, text: '', loading: false, error: (error as Error)?.message || 'Failed to read output' });
    }
  };

  if (tasks.length === 0) return null;

  const label = runningCount > 0 ? `${runningCount} running` : `${tasks.length} done`;

  return (
    <div className="relative" ref={ref}>
      <button
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

      {open && (
        <div className="absolute bottom-full right-0 z-50 mb-2 w-80 max-w-[85vw] overflow-hidden rounded-xl border border-border bg-card shadow-lg">
          <div className="border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">
            Background tasks
          </div>
          <div className="max-h-80 overflow-y-auto">
            {tasks.map((task) => (
              <div key={task.id} className="border-b border-border/50 last:border-b-0">
                <button
                  type="button"
                  onClick={() => void viewOutput(task)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
                >
                  <StatusIcon status={task.status} />
                  <span className="min-w-0 flex-1 truncate" title={task.label}>{task.label}</span>
                  {task.status === 'failed' && task.exitCode !== null && (
                    <span className="flex-shrink-0 text-xs text-red-500">exit {task.exitCode}</span>
                  )}
                  <ChevronDown
                    className={`h-3 w-3 flex-shrink-0 text-muted-foreground transition-transform ${expandedId === task.id ? 'rotate-180' : ''}`}
                  />
                </button>
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
        </div>
      )}
    </div>
  );
}
