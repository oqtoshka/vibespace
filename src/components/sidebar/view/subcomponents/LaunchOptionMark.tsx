import { SlidersHorizontal } from 'lucide-react';

/**
 * A plugin launch-option mark beside a session's title: glyph plus the word,
 * never colour alone, with the plugin's hint as the tooltip.
 */
export default function LaunchOptionMark({ label, hint }: { label: string; hint?: string }) {
  return (
    <span
      className="inline-flex min-w-0 items-center gap-0.5 rounded-sm bg-sky-500/10 px-1 text-[11px] font-medium text-sky-700 dark:text-sky-300"
      title={hint ? `${label} — ${hint}` : label}
      data-testid="session-launch-option-mark"
    >
      <SlidersHorizontal className="h-2.5 w-2.5 flex-shrink-0" aria-hidden />
      <span className="truncate">{label}</span>
    </span>
  );
}
