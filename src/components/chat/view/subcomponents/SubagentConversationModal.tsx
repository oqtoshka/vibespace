import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bot, Loader2, User, X } from 'lucide-react';

import { api } from '../../../../utils/api';
import { ToolRenderer } from '../../tools/ToolRenderer';
import type { Subagent } from '../../hooks/useSubagents';

type SubagentConversationEntry =
  | { type: 'user' | 'assistant' | 'thinking'; content: string; timestamp?: string }
  | {
    type: 'tool';
    toolId?: string;
    toolName: string;
    toolInput: unknown;
    toolResult: { content: string; isError: boolean } | null;
    timestamp?: string;
  };

type Props = {
  sessionId: string;
  subagent: Subagent;
  onClose: () => void;
};

/**
 * Read-only viewer for a subagent's full conversation — its launching prompt,
 * replies, thinking, and tool calls — fetched from the subagent transcript.
 * Subagent turns are hidden from the main thread; this is where you inspect them.
 */
export default function SubagentConversationModal({ sessionId, subagent, onClose }: Props) {
  const [entries, setEntries] = useState<SubagentConversationEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setEntries(null);

    if (!subagent.agentId) {
      setLoading(false);
      setError('This subagent is still starting — its transcript isn’t available yet.');
      return;
    }

    (async () => {
      try {
        const res = await api.subagentConversation(sessionId, subagent.agentId as string, { signal: controller.signal });
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(data?.error || 'Failed to load subagent conversation');
          setLoading(false);
          return;
        }
        setEntries(Array.isArray(data.messages) ? data.messages : []);
        setLoading(false);
      } catch (err) {
        if (cancelled || (err as Error)?.name === 'AbortError') return;
        setError((err as Error)?.message || 'Failed to load subagent conversation');
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [sessionId, subagent.agentId]);

  // Portal to <body>: the composer's backdrop-blur ancestor forms a containing
  // block that would otherwise trap `position: fixed` and mis-anchor the modal.
  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Bot className="h-4 w-4 flex-shrink-0 text-purple-500" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-foreground">{subagent.label}</div>
            {subagent.subagentType && (
              <div className="truncate text-xs text-muted-foreground">{subagent.subagentType}</div>
            )}
          </div>
          {subagent.status === 'running' && (
            <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/10 px-2 py-0.5 text-[10px] font-medium text-blue-600 dark:text-blue-400">
              <Loader2 className="h-3 w-3 animate-spin" /> running
            </span>
          )}
          <button
            type="button"
            onClick={onClose}
            className="flex-shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading conversation…
            </div>
          )}
          {error && !loading && <div className="py-6 text-center text-sm text-red-500">{error}</div>}
          {!loading && !error && entries && entries.length === 0 && (
            <div className="py-6 text-center text-sm text-muted-foreground">No conversation recorded.</div>
          )}
          {!loading && !error && entries?.map((entry, i) => {
            if (entry.type === 'tool') {
              return (
                <div key={i} className="text-sm">
                  <ToolRenderer
                    mode="input"
                    toolName={entry.toolName}
                    toolInput={entry.toolInput}
                    toolResult={entry.toolResult}
                    toolId={entry.toolId}
                  />
                </div>
              );
            }
            if (entry.type === 'thinking') {
              return (
                <div key={i} className="rounded-lg border border-border/50 bg-muted/30 px-3 py-2 text-xs italic text-muted-foreground">
                  {entry.content}
                </div>
              );
            }
            const isUser = entry.type === 'user';
            return (
              <div key={i} className="flex gap-2">
                <div className="mt-0.5 flex-shrink-0">
                  {isUser ? (
                    <User className="h-4 w-4 text-muted-foreground" />
                  ) : (
                    <Bot className="h-4 w-4 text-purple-500" />
                  )}
                </div>
                <div
                  className={`min-w-0 flex-1 whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-sm ${
                    isUser ? 'bg-accent/60 text-foreground' : 'bg-muted/40 text-foreground'
                  }`}
                >
                  {entry.content}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}
