import { useCallback, useRef, useState, useEffect } from 'react';
import { PanelLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { MainContentHeaderProps } from '../../types/types';
import { Tooltip, Pill } from '../../../../shared/view/ui';

import MobileMenuButton from './MobileMenuButton';
import WorkspaceTabStrip from './WorkspaceTabStrip';
import WorkspacePanelBar from './WorkspacePanelBar';
import TerminalPaneButton from './TerminalPaneButton';

export default function MainContentHeader({
  workspace,
  selectedProject,
  selectedSession,
  shouldShowTasksTab,
  isMobile,
  onMenuClick,
  onCloseTab,
  sessionPaneOpen,
  onToggleSessionPane,
  terminalPaneOpen,
  onToggleTerminalPane,
}: MainContentHeaderProps) {
  const { t } = useTranslation();
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
    if (el.firstElementChild) observer.observe(el.firstElementChild);

    return () => observer.disconnect();
  }, [updateScrollState]);

  // Vertical wheel over the tab strip scrolls it horizontally (upstream).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const handleWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;

      const maxScrollLeft = el.scrollWidth - el.clientWidth;
      const canMove = event.deltaY < 0 ? el.scrollLeft > 0 : el.scrollLeft < maxScrollLeft;
      if (!canMove) return;

      event.preventDefault();
      const lineMultiplier = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 20 : 1;
      el.scrollBy({ left: event.deltaY * lineMultiplier, behavior: 'auto' });
    };

    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, []);

  // VSCode-style: tabs flow left-to-right from the leading edge; fixed
  // actions (panel toggles, new shell, terminal) sit at the trailing edge.
  return (
    <div className="pwa-header-safe flex-shrink-0 border-b border-border/60 bg-background px-2 py-1.5 sm:px-3 sm:py-2">
      <div className="flex items-center gap-2">
        {isMobile && <MobileMenuButton onMenuClick={onMenuClick} />}

        {!isMobile && (
          <Tooltip
            content={
              sessionPaneOpen
                ? t('sessionPane.close', { defaultValue: 'Hide session pane' })
                : t('sessionPane.show', { defaultValue: 'Show session' })
            }
            position="bottom"
          >
            <Pill isActive={sessionPaneOpen} onClick={onToggleSessionPane} className="px-2 py-[5px]">
              <PanelLeft className="h-3.5 w-3.5" strokeWidth={sessionPaneOpen ? 2.2 : 1.8} />
            </Pill>
          </Tooltip>
        )}

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
        </div>

        <div className="flex flex-shrink-0 items-center gap-2">
          <WorkspacePanelBar
            workspace={workspace}
            shouldShowTasksTab={shouldShowTasksTab}
          />
          <TerminalPaneButton isOpen={terminalPaneOpen} onToggle={onToggleTerminalPane} />
        </div>
      </div>
    </div>
  );
}
