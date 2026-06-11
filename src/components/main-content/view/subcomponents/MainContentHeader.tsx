import { useCallback, useRef, useState, useEffect } from 'react';
import type { MainContentHeaderProps } from '../../types/types';
import MobileMenuButton from './MobileMenuButton';
import WorkspaceTabStrip from './WorkspaceTabStrip';
import MainContentTitle from './MainContentTitle';
import OpenInTerminalButton from './OpenInTerminalButton';

export default function MainContentHeader({
  workspace,
  selectedProject,
  selectedSession,
  shouldShowTasksTab,
  isMobile,
  onMenuClick,
  onCloseTab,
  onNewShell,
}: MainContentHeaderProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateScrollState = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 2);
    setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 2);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    updateScrollState();
    const observer = new ResizeObserver(updateScrollState);
    observer.observe(el);
    return () => observer.disconnect();
  }, [updateScrollState]);

  return (
    <div className="pwa-header-safe flex-shrink-0 border-b border-border/60 bg-background px-3 py-1.5 sm:px-4 sm:py-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-shrink-[3] basis-1/4 items-center gap-2 sm:flex-1">
          {isMobile && <MobileMenuButton onMenuClick={onMenuClick} />}
          <MainContentTitle
            workspace={workspace}
            selectedProject={selectedProject}
            selectedSession={selectedSession}
            shouldShowTasksTab={shouldShowTasksTab}
          />
        </div>

        {/* The tab strip can grow arbitrarily wide — it must shrink and
            scroll within the viewport rather than push the layout. */}
        <div className="flex min-w-0 flex-shrink items-center gap-2">
          <OpenInTerminalButton
            selectedProject={selectedProject}
            selectedSession={selectedSession}
          />
          <div className="relative min-w-0 flex-shrink overflow-hidden">
          {canScrollLeft && (
            <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-6 bg-gradient-to-r from-background to-transparent" />
          )}
          <div
            ref={scrollRef}
            onScroll={updateScrollState}
            className="scrollbar-hide overflow-x-auto"
          >
            <WorkspaceTabStrip
              workspace={workspace}
              selectedProject={selectedProject}
              shouldShowTasksTab={shouldShowTasksTab}
              onCloseTab={onCloseTab}
              onNewShell={onNewShell}
            />
          </div>
          {canScrollRight && (
            <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-6 bg-gradient-to-l from-background to-transparent" />
          )}
          </div>
        </div>
      </div>
    </div>
  );
}
