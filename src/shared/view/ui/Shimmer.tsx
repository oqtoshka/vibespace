import * as React from 'react';

import { cn } from '../../../lib/utils';

interface ShimmerProps {
  children: string;
  className?: string;
  as?: React.ElementType;
  /**
   * Whether the sweep is running. The shimmer animates `background-position`
   * on a `background-clip: text` element, which is not compositable — every
   * frame re-rasterises the gradient through the glyphs (~100 style recalcs/s).
   * Callers must switch it off the moment the work it signals has finished;
   * an inactive shimmer renders as plain muted text with identical layout.
   */
  active?: boolean;
}

const Shimmer = React.memo<ShimmerProps>(({ children, className, as: Component = 'span', active = true }) => {
  return (
    <Component
      className={cn(
        'inline-block',
        active
          ? 'animate-shimmer bg-[length:250%_100%] bg-clip-text text-transparent bg-[linear-gradient(90deg,transparent_33%,hsl(var(--foreground))_50%,transparent_67%),linear-gradient(hsl(var(--muted-foreground)),hsl(var(--muted-foreground)))]'
          : 'text-muted-foreground',
        className
      )}
    >
      {children}
    </Component>
  );
});
Shimmer.displayName = 'Shimmer';

export { Shimmer };
