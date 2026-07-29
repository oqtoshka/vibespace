import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { ArrowRight, MessageCircleQuestion, Square, X } from 'lucide-react';

import { Button, Dialog, DialogContent, DialogTitle } from '../../../../shared/view/ui';
import type { BtwExchange } from '../../hooks/useBtwSession';

import { Markdown } from './Markdown';

/**
 * The `/btw` panel: a quick question and its answer, side by side with the
 * session that keeps running behind it.
 *
 * It deliberately looks nothing like the main chat. A btw is a detour — a
 * couple of turns, read-only, thrown away when the panel closes — so it gets a
 * plain question/answer list rather than the full message surface with tools,
 * diffs and permissions. What it does offer is the exit: "Continue as session"
 * branches the exchange out into a real conversation, because the answer
 * already lives in a real provider session.
 */

type BtwPanelProps = {
  isOpen: boolean;
  onClose: () => void;
  exchanges: BtwExchange[];
  isStreaming: boolean;
  canPromote: boolean;
  isPromoted: boolean;
  onAsk: (question: string) => void;
  onAbort: () => void;
  onBranchOut: () => void;
  projectId?: string | null;
  projectPath?: string | null;
};

export default function BtwPanel({
  isOpen,
  onClose,
  exchanges,
  isStreaming,
  canPromote,
  isPromoted,
  onAsk,
  onAbort,
  onBranchOut,
  projectId = null,
  projectPath = null,
}: BtwPanelProps) {
  const [question, setQuestion] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen) {
      // Focus after the dialog's own mount work, or the ref is not attached yet.
      const frame = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(frame);
    }
    return undefined;
  }, [isOpen]);

  // Follow the streaming answer. The dependency is the whole array so this
  // also fires on each appended chunk, not just on a new exchange.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (scroller) {
      scroller.scrollTop = scroller.scrollHeight;
    }
  }, [exchanges]);

  const submit = useCallback(() => {
    const trimmed = question.trim();
    if (!trimmed || isStreaming) return;
    onAsk(trimmed);
    setQuestion('');
  }, [isStreaming, onAsk, question]);

  const handleSubmit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      submit();
    },
    [submit],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        submit();
      }
    },
    [submit],
  );

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex h-[min(80dvh,40rem)] w-[calc(100vw-1rem)] max-w-2xl flex-col overflow-hidden rounded-3xl border-border/80 bg-popover/95 p-0 shadow-2xl backdrop-blur-xl">
        <DialogTitle className="sr-only">Quick question</DialogTitle>

        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border bg-popover px-4 py-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-muted text-foreground">
              <MessageCircleQuestion className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                By the way
              </p>
              <p className="mt-0.5 truncate text-lg font-semibold tracking-tight text-foreground">
                Quick question
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div ref={scrollRef} className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4 sm:px-6">
          {exchanges.length === 0 && (
            <p className="pt-6 text-center text-sm text-muted-foreground">
              Ask anything. This runs beside your session — it will not interrupt the turn
              in flight, and it cannot edit files or run commands.
            </p>
          )}

          {exchanges.map((exchange) => (
            <div key={exchange.id} className="space-y-2">
              <p className="rounded-2xl bg-muted px-3 py-2 text-sm font-medium text-foreground">
                {exchange.question}
              </p>

              {exchange.status === 'error' ? (
                <p className="px-1 text-sm text-destructive">{exchange.error}</p>
              ) : (
                <div className="px-1 text-sm">
                  {exchange.answer ? (
                    <Markdown projectId={projectId} projectPath={projectPath}>
                      {exchange.answer}
                    </Markdown>
                  ) : (
                    <p className="text-muted-foreground">Thinking…</p>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="shrink-0 space-y-3 border-t border-border bg-popover px-4 py-3 sm:px-6">
          <form onSubmit={handleSubmit} className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={handleKeyDown}
              rows={1}
              placeholder="Ask something quick…"
              className="max-h-32 min-h-10 flex-1 resize-none rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
            />
            {isStreaming ? (
              <Button type="button" variant="outline" onClick={onAbort} title="Stop">
                <Square className="h-4 w-4" />
              </Button>
            ) : (
              <Button type="submit" disabled={!question.trim()}>
                Ask
              </Button>
            )}
          </form>

          {(canPromote || isPromoted) && (
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                {isPromoted
                  ? 'This is a full session now — find it in the sidebar.'
                  : 'Want to keep going? Carry this on as its own session.'}
              </p>
              {canPromote && (
                <Button type="button" variant="outline" size="sm" onClick={onBranchOut}>
                  Continue as session
                  <ArrowRight className="ml-1 h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
