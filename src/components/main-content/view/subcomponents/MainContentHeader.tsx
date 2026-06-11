import { useCallback, useRef, useState, useEffect } from 'react';
import { Folder } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Tooltip, Pill } from '../../../../shared/view/ui';
import type { MainContentHeaderProps } from '../../types/types';
import MobileMenuButton from './MobileMenuButton';
import WorkspaceTabStrip from './WorkspaceTabStrip';
import OpenInTerminalButton from './OpenInTerminalButton';

export default function MainContentHeader({
  workspace,
  selectedProject,
  selectedSession,
  shouldShowTasksTab,
  shouldShowBrowserTab,
  isMobile,
  onMenuClick,
  onCloseTab,
  onNewShell,
  filesSidebarActive,
  onShowFilesSidebar,
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
    return () => observer.disconnect();
  }, [updateScrollState]);

  // VSCode-style: tabs flow left-to-right from the leading edge; fixed
  // actions (files sidebar toggle, terminal) sit at the trailing edge.
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
              shouldShowTasksTab={shouldShowTasksTab}
              shouldShowBrowserTab={shouldShowBrowserTab}
              onCloseTab={onCloseTab}
              onNewShell={onNewShell}
            />
          </div>
          {canScrollRight && (
            <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-6 bg-gradient-to-l from-background to-transparent" />
          )}
        </div>

        <div className="flex flex-shrink-0 items-center gap-2">
          <Tooltip content={t('tabs.files')} position="bottom">
            <Pill isActive={filesSidebarActive} onClick={onShowFilesSidebar} className="px-2.5 py-[5px]">
              <Folder className="h-3.5 w-3.5" strokeWidth={filesSidebarActive ? 2.2 : 1.8} />
            </Pill>
          </Tooltip>
          <OpenInTerminalButton
            selectedProject={selectedProject}
            selectedSession={selectedSession}
          />
        </div>
      </div>
    </div>
  );
}
