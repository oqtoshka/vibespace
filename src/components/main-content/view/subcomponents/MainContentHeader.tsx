import { useCallback, useRef, useState, useEffect } from 'react';
import type { MainContentHeaderProps } from '../../types/types';
import MobileMenuButton from './MobileMenuButton';
import WorkspaceTabStrip from './WorkspaceTabStrip';
import WorkspacePanelBar from './WorkspacePanelBar';
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

  // VSCode-style: tabs flow left-to-right from the leading edge; fixed
  // actions (panel toggles, new shell, terminal) sit at the trailing edge.
  return (
    <div className="pwa-header-safe flex-shrink-0 border-b border-border/60 bg-background px-2 py-1.5 sm:px-3 sm:py-2">
      <div className="flex items-center gap-2">
        {isMobile && <MobileMenuButton onMenuClick={onMenuClick} />}

        <div className="relative min-w-0 flex-1 overflow-hidden">
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
              onCloseTab={onCloseTab}
            />
          </div>
          {canScrollRight && (
            <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-6 bg-gradient-to-l from-background to-transparent" />
          )}
        </div>

        <div className="flex flex-shrink-0 items-center gap-2">
          <WorkspacePanelBar
            workspace={workspace}
            shouldShowTasksTab={shouldShowTasksTab}
            onNewShell={onNewShell}
          />
          <OpenInTerminalButton
            selectedProject={selectedProject}
            selectedSession={selectedSession}
          />
        </div>
      </div>
    </div>
  );
}
