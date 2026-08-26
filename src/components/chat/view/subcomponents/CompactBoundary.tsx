import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArchiveIcon, ChevronDownIcon } from 'lucide-react';

import type { CompactionInfo } from '../../../../stores/useSessionStore';
import type { Project } from '../../../../types/app';

import { Markdown } from './Markdown';

/** Compact token count for the compaction divider (180000 → "180k"). */
const formatCompactTokens = (value: number) => {
  if (value >= 1000) {
    return `${Math.round(value / 1000)}k`;
  }
  return String(value);
};

const PILL_CLASSES = 'flex items-center gap-1.5 whitespace-nowrap rounded-full border border-border/70 bg-muted/40 px-2.5 py-1 text-[11px] text-muted-foreground';

type CompactBoundaryProps = {
  compaction?: CompactionInfo;
  onFileOpen?: ((filePath: string) => void) | null;
  selectedProject?: Project | null;
};

/**
 * The seam where the conversation was summarized.
 *
 * Everything above it left the model's context, which is otherwise invisible —
 * the transcript just carries on and the agent quietly stops remembering the
 * earlier turns. The summary the runtime kept is worth having, but only when
 * something looks wrong later, so it stays folded behind the marker: a
 * compaction summary runs to thousands of words, and every CLI replays it as a
 * turn that would otherwise land in the transcript as a wall of text attributed
 * to whoever the runtime happened to send it as.
 */
const CompactBoundary = memo(({ compaction, onFileOpen, selectedProject }: CompactBoundaryProps) => {
  const { t } = useTranslation('chat');
  const [isOpen, setIsOpen] = useState(false);

  const trigger = compaction?.trigger === 'auto'
    ? t('compaction.auto', { defaultValue: 'Context auto-compacted' })
    : t('compaction.manual', { defaultValue: 'Context compacted' });
  const before = typeof compaction?.preTokens === 'number' ? compaction.preTokens : null;
  const after = typeof compaction?.postTokens === 'number' ? compaction.postTokens : null;
  const shrink = before !== null && after !== null
    ? `${formatCompactTokens(before)} → ${formatCompactTokens(after)}`
    : before !== null
      ? formatCompactTokens(before)
      : null;
  const summary = compaction?.summary?.trim() || '';
  const durationTitle = compaction?.durationMs
    ? t('compaction.duration', {
      defaultValue: 'Took {{seconds}}s',
      seconds: Math.round(compaction.durationMs / 1000),
    })
    : undefined;

  const pillContent = (
    <>
      <ArchiveIcon className="h-3 w-3 flex-shrink-0" />
      <span>{trigger}</span>
      {shrink && <span className="font-mono text-muted-foreground/80">{shrink}</span>}
      {summary && (
        <ChevronDownIcon
          className={`h-3 w-3 flex-shrink-0 transition-transform ${isOpen ? 'rotate-180' : 'rotate-0'}`}
        />
      )}
    </>
  );

  return (
    <div className="chat-message system px-3 py-2 sm:px-0">
      <div className="flex items-center gap-3" role="separator">
        <span className="h-px flex-1 bg-border" />
        {summary ? (
          <button
            type="button"
            onClick={() => setIsOpen((open) => !open)}
            aria-expanded={isOpen}
            title={durationTitle}
            className={`${PILL_CLASSES} transition-colors hover:border-border hover:bg-muted/70 hover:text-foreground`}
          >
            {pillContent}
          </button>
        ) : (
          <span className={PILL_CLASSES} title={durationTitle}>
            {pillContent}
          </span>
        )}
        <span className="h-px flex-1 bg-border" />
      </div>

      {summary && isOpen && (
        <div className="mt-2 max-h-[60vh] overflow-y-auto rounded-lg border border-border/70 bg-muted/20 px-3 py-2">
          <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
            {t('compaction.summaryLabel', { defaultValue: 'Summary kept in context' })}
          </div>
          <Markdown
            className="prose prose-sm prose-gray max-w-none font-serif dark:prose-invert"
            onFileOpen={onFileOpen}
            projectId={selectedProject?.projectId}
            projectPath={selectedProject?.fullPath}
          >
            {summary}
          </Markdown>
        </div>
      )}
    </div>
  );
});

CompactBoundary.displayName = 'CompactBoundary';

export default CompactBoundary;
