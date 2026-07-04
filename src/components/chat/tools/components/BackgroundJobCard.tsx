import React, { useEffect, useRef, useState } from 'react';
import { CheckCircle2, ChevronRight, Copy, Check, Loader2, Terminal, XCircle, X } from 'lucide-react';

import { cn } from '../../../../lib/utils';
import { copyTextToClipboard } from '../../../../utils/clipboard';
import { api } from '../../../../utils/api';
import { useBackgroundTasksContext } from '../../context/BackgroundTasksContext';
import type { BackgroundTaskStatus } from '../../hooks/useBackgroundTasks';

interface BackgroundJobCardProps {
  command: string;
  description?: string;
  taskId: string;
  outputFile: string | null;
}

const OUTPUT_POLL_MS = 2000;

function StatusChip({ status }: { status: BackgroundTaskStatus }) {
  if (status === 'running') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-medium text-blue-600 dark:text-blue-400">
        <Loader2 className="h-3 w-3 animate-spin" /> running
      </span>
    );
  }
  if (status === 'failed') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 px-1.5 py-0.5 text-[10px] font-medium text-red-600 dark:text-red-400">
        <XCircle className="h-3 w-3" /> failed
      </span>
    );
  }
  if (status === 'completed') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
        <CheckCircle2 className="h-3 w-3" /> done
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
      <Terminal className="h-3 w-3" /> finished
    </span>
  );
}

/**
 * A `run_in_background` bash launch, rendered as a live-monitorable card
 * instead of the raw "Command running in background…" acknowledgement. Expands
 * to stream the job's output file (polled while it runs) and offers a Cancel
 * button that stops just this job via the SDK. Status is read from the
 * session-level background-task context (server-reconciled ground truth).
 */
export const BackgroundJobCard: React.FC<BackgroundJobCardProps> = ({
  command,
  description,
  taskId,
  outputFile,
}) => {
  const ctx = useBackgroundTasksContext();
  const task = ctx?.tasksById.get(taskId);
  const status: BackgroundTaskStatus = task?.status ?? 'ended';
  const isRunning = status === 'running';
  const canCancel = Boolean(ctx?.canCancel) && isRunning;

  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [output, setOutput] = useState<{ text: string; loading: boolean; error?: string }>({
    text: '',
    loading: false,
  });

  // Fetch the output file when expanded; keep polling while the job runs so the
  // panel streams. A finished job is fetched once.
  useEffect(() => {
    if (!open || !outputFile) return;
    let cancelled = false;
    let controller: AbortController | null = null;

    const fetchOnce = async (showSpinner: boolean) => {
      if (showSpinner) setOutput((prev) => ({ ...prev, loading: prev.text === '' }));
      controller?.abort();
      controller = new AbortController();
      try {
        const res = await api.taskOutput(outputFile, { signal: controller.signal });
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setOutput({ text: '', loading: false, error: data?.error || 'Failed to read output' });
          return;
        }
        setOutput({ text: data.content || '(no output yet)', loading: false });
      } catch (error) {
        if (cancelled || (error as Error)?.name === 'AbortError') return;
        setOutput({ text: '', loading: false, error: (error as Error)?.message || 'Failed to read output' });
      }
    };

    void fetchOnce(true);
    const timer = isRunning ? window.setInterval(() => void fetchOnce(false), OUTPUT_POLL_MS) : null;
    return () => {
      cancelled = true;
      controller?.abort();
      if (timer) window.clearInterval(timer);
    };
  }, [open, outputFile, isRunning]);

  const handleCopy = async (event: React.MouseEvent) => {
    event.stopPropagation();
    const didCopy = await copyTextToClipboard(command);
    if (!didCopy) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleCancel = (event: React.MouseEvent) => {
    event.stopPropagation();
    ctx?.cancelTask(taskId);
  };

  const toggle = () => setOpen((prev) => !prev);

  return (
    <div
      className={cn(
        'group/bg overflow-hidden rounded-lg border bg-muted/40 backdrop-blur-sm transition-all duration-200',
        status === 'failed' ? 'border-red-500/30' : isRunning ? 'border-blue-500/30' : 'border-border/60',
        !open && 'hover:border-border hover:bg-muted/60',
        open && 'bg-muted/50 shadow-sm',
      )}
    >
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggle();
          }
        }}
        className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <ChevronRight
          className={cn(
            'h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/70 transition-transform duration-200',
            open && 'rotate-90',
          )}
        />
        <span className="flex-shrink-0 select-none font-mono text-xs font-semibold text-emerald-500 dark:text-emerald-400">
          $
        </span>
        <code className={cn('min-w-0 flex-1 font-mono text-xs text-foreground', open ? 'whitespace-pre-wrap break-all' : 'truncate')}>
          {command}
        </code>

        <StatusChip status={status} />

        {canCancel && (
          <button
            onClick={handleCancel}
            onKeyDown={(event) => event.stopPropagation()}
            className="flex flex-shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground/70 transition-colors hover:bg-red-500/10 hover:text-red-600 dark:hover:text-red-400"
            title="Cancel this background job"
            aria-label="Cancel background job"
          >
            <X className="h-3 w-3" /> cancel
          </button>
        )}

        <button
          onClick={handleCopy}
          onKeyDown={(event) => event.stopPropagation()}
          className="flex-shrink-0 rounded p-0.5 text-muted-foreground/60 opacity-0 transition-all hover:bg-foreground/10 hover:text-foreground focus:opacity-100 group-hover/bg:opacity-100"
          title="Copy command"
          aria-label="Copy command"
        >
          {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      </div>

      {description && !open && (
        <div className="truncate px-2.5 pb-1.5 pl-[2.4rem] text-[11px] italic text-muted-foreground/70">
          {description}
        </div>
      )}

      {open && (
        <div className="settings-content-enter border-t border-border/50 bg-background/50">
          {description && (
            <div className="px-3 pt-2 text-[11px] italic text-muted-foreground/70">{description}</div>
          )}
          {output.loading ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">Loading output…</div>
          ) : output.error ? (
            <div className="px-3 py-2 text-xs text-red-500">{output.error}</div>
          ) : (
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all px-3 py-2 font-mono text-xs leading-relaxed text-muted-foreground">
              {output.text}
              {isRunning && <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-muted-foreground/50 align-middle" />}
            </pre>
          )}
        </div>
      )}
    </div>
  );
};
