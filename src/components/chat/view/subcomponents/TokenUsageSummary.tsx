import { ActivityIcon } from 'lucide-react';

import type { ContextUsage } from '../../../../stores/useSessionStore';

type TokenUsageSummaryProps = {
  usage: Record<string, unknown> | null;
  /** Live runtime reading; supersedes the estimate derived from `usage`. */
  contextUsage?: ContextUsage | null;
  onClick?: () => void;
};

export const formatTokenCount = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) {
    return '0';
  }

  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  }

  if (value >= 10_000) {
    return `${Math.round(value / 1_000)}K`;
  }

  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }

  return value.toLocaleString();
};

const readUsageNumber = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export const readUsedTokens = (usage: Record<string, unknown> | null) => {
  const breakdown =
    usage?.breakdown && typeof usage.breakdown === 'object'
      ? usage.breakdown as Record<string, unknown>
      : null;
  const inputTokens = readUsageNumber(usage?.inputTokens ?? breakdown?.input);
  const outputTokens = readUsageNumber(usage?.outputTokens ?? breakdown?.output);
  return readUsageNumber(usage?.used) || inputTokens + outputTokens;
};

export type ContextGauge = {
  used: number;
  max: number;
  /** 0–100, clamped. */
  percentage: number;
  /** 0–100 mark where auto-compaction kicks in, when it is enabled. */
  compactAtPercent: number | null;
  autoCompactEnabled: boolean;
  /** True when derived from transcript usage rather than the live runtime. */
  estimated: boolean;
};

/**
 * Turns the runtime's auto-compact threshold into a 0-100 mark on the gauge.
 *
 * The runtime reports it as an ABSOLUTE TOKEN COUNT — Opus 5 with a 1M window
 * reports 967000, not 0.967. Multiplying it by 100 as if it were a fraction
 * produced `left: 96700000%` on the marker and "Auto-compacts at 96700000%" in
 * the tooltip. That stayed invisible for as long as auto-compact was off,
 * because the caller only asks for this when it is enabled.
 *
 * Both readings are accepted rather than assuming the current one: a value at
 * or below 1 can only be a fraction (a 1-token threshold is meaningless), and
 * anything larger can only be a token count.
 */
export const resolveCompactAtPercent = (threshold: unknown, maxTokens: number): number | null => {
  const value = Number(threshold);
  if (!Number.isFinite(value) || value <= 0 || maxTokens <= 0) {
    return null;
  }

  const percent = value <= 1 ? value * 100 : (value / maxTokens) * 100;
  if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
    return null;
  }

  return Math.round(percent);
};

/**
 * Resolves what to show in the gauge from the two available signals.
 *
 * The live runtime reading is authoritative — it knows the real window for the
 * model in use and whether auto-compaction is on. Before a session has one
 * (freshly opened, nothing sent yet) we fall back to the transcript estimate,
 * which is the same used/total pair the token counter has always shown, and
 * mark it `estimated` so the UI can avoid over-claiming precision.
 */
export const resolveContextGauge = (
  usage: Record<string, unknown> | null,
  contextUsage?: ContextUsage | null,
): ContextGauge | null => {
  if (contextUsage && contextUsage.maxTokens > 0) {
    return {
      used: contextUsage.totalTokens,
      max: contextUsage.maxTokens,
      percentage: Math.min(100, Math.max(0, contextUsage.percentage)),
      compactAtPercent: contextUsage.isAutoCompactEnabled
        ? resolveCompactAtPercent(contextUsage.autoCompactThreshold, contextUsage.maxTokens)
        : null,
      autoCompactEnabled: contextUsage.isAutoCompactEnabled,
      estimated: false,
    };
  }

  const used = readUsedTokens(usage);
  const max = readUsageNumber(usage?.total);
  if (used <= 0 || max <= 0) {
    return null;
  }

  return {
    used,
    max,
    percentage: Math.min(100, Math.max(0, (used / max) * 100)),
    compactAtPercent: null,
    // Unknown rather than false, but the estimate never claims a threshold, so
    // the UI treats it as "no compaction promised" — the safe reading.
    autoCompactEnabled: false,
    estimated: true,
  };
};

/**
 * Colour bands. Deliberately not a smooth gradient: the point is to answer
 * "do I need to do something about this?" at a glance, and there are only
 * three answers — no, soon, now.
 */
const gaugeTone = (gauge: ContextGauge) => {
  if (gauge.percentage >= 90) {
    return { bar: 'bg-red-500', text: 'text-red-500', track: 'bg-red-500/15' };
  }
  if (gauge.percentage >= 70) {
    return { bar: 'bg-amber-500', text: 'text-amber-500', track: 'bg-amber-500/15' };
  }
  return { bar: 'bg-primary', text: 'text-foreground', track: 'bg-primary/15' };
};

const buildTitle = (gauge: ContextGauge | null, usedTokens: number) => {
  if (!gauge) {
    return `${usedTokens.toLocaleString()} tokens used`;
  }

  const lines = [
    `${gauge.used.toLocaleString()} / ${gauge.max.toLocaleString()} tokens (${Math.round(gauge.percentage)}% of context)`,
  ];

  if (gauge.compactAtPercent !== null) {
    lines.push(`Auto-compacts at ${gauge.compactAtPercent}%`);
  } else if (!gauge.estimated) {
    lines.push('Auto-compact is off — run /compact before the window fills');
  }

  if (gauge.estimated) {
    lines.push('Estimated from the transcript; exact once a turn runs');
  }

  return lines.join('\n');
};

export default function TokenUsageSummary({ usage, contextUsage, onClick }: TokenUsageSummaryProps) {
  const usedTokens = readUsedTokens(usage);
  const gauge = resolveContextGauge(usage, contextUsage);
  const tone = gauge ? gaugeTone(gauge) : null;

  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border/70 bg-background/70 px-2 text-xs text-muted-foreground shadow-sm transition-colors hover:border-primary/25 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:gap-2 sm:px-2.5"
      title={buildTitle(gauge, usedTokens)}
      aria-label={
        gauge
          ? `Context ${Math.round(gauge.percentage)} percent full. Show token usage`
          : 'Show token usage'
      }
    >
      <span className="grid h-5 w-5 place-items-center rounded-md bg-primary/10 text-primary">
        <ActivityIcon className="h-3.5 w-3.5" />
      </span>
      <span className="font-medium text-foreground">{formatTokenCount(gauge ? gauge.used : usedTokens)}</span>

      {gauge && tone ? (
        <>
          {/* The bar carries the reading; the number next to it is for anyone
              who wants the exact value without hovering. */}
          <span className={`relative hidden h-1.5 w-10 overflow-hidden rounded-full sm:block ${tone.track}`}>
            <span
              className={`absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ${tone.bar}`}
              style={{ width: `${Math.max(2, gauge.percentage)}%` }}
            />
            {gauge.compactAtPercent !== null && (
              // Where auto-compaction will fire: past this mark the session
              // rescues itself, so a high reading is not a problem.
              <span
                className="absolute inset-y-0 w-px bg-foreground/40"
                style={{ left: `${gauge.compactAtPercent}%` }}
              />
            )}
          </span>
          <span className={`font-medium tabular-nums ${tone.text}`}>
            {Math.round(gauge.percentage)}%
          </span>
        </>
      ) : (
        <span className="hidden text-muted-foreground/70 sm:inline">tokens</span>
      )}
    </button>
  );
}
