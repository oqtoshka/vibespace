import { FileText, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Tooltip, PillBar, Pill } from '../../../../shared/view/ui';
import type { Project } from '../../../../types/app';
import type { WorkspaceApi } from '../../types/types';

type WorkspaceTabStripProps = {
  workspace: WorkspaceApi;
  selectedProject: Project;
  onCloseTab: (id: string) => void;
};

/** File tabs only — chat and terminal live in the session pane, not here. */
export default function WorkspaceTabStrip({ workspace, onCloseTab }: WorkspaceTabStripProps) {
  const { t } = useTranslation();

  return (
    <PillBar>
      {workspace.tabs.map((tab) => {
        const isActive = tab.id === workspace.activeId;
        const title = tab.name;

        return (
          <Tooltip key={tab.id} content={tab.path} position="bottom">
            <Pill
              isActive={isActive}
              onClick={() => workspace.activateTab(tab.id)}
              className="px-2 py-[5px]"
            >
              <FileText className="h-3.5 w-3.5 flex-shrink-0" strokeWidth={isActive ? 2.2 : 1.8} />
              <span className="max-w-[120px] truncate">{title}</span>
              <span
                role="button"
                tabIndex={-1}
                aria-label={t('mainContent.closeTab', { defaultValue: 'Close tab' })}
                onClick={(event) => {
                  event.stopPropagation();
                  onCloseTab(tab.id);
                }}
                className="-mr-0.5 ml-0.5 rounded p-0.5 opacity-60 hover:bg-foreground/10 hover:opacity-100"
              >
                <X className="h-3 w-3" />
              </span>
            </Pill>
          </Tooltip>
        );
      })}
    </PillBar>
  );
}
