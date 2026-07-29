import type { ReactNode } from 'react';

/**
 * One button in a preview's floating control cluster (zoom, fit, fullscreen).
 * Shared so the clusters on a diagram, an HTML page and a CSV table are the
 * same size and read as the same control.
 */
export default function PreviewControlButton({
  onClick,
  title,
  children,
}: {
  onClick: () => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      {children}
    </button>
  );
}

/**
 * The container the buttons sit in: pinned top-right, dimmed until pointed at
 * so it doesn't obscure the thing it controls.
 */
export function PreviewControlCluster({ children }: { children: ReactNode }) {
  return (
    <div className="absolute right-3 top-3 z-10 flex items-center gap-0.5 rounded-lg border border-border/60 bg-background/95 p-0.5 opacity-70 shadow-sm backdrop-blur transition-opacity focus-within:opacity-100 hover:opacity-100">
      {children}
    </div>
  );
}
