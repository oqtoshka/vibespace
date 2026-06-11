import {
  ClipboardCheck,
  FileText,
  Folder,
  GitBranch,
  MessageSquare,
  Plus,
  Terminal,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Tooltip, PillBar, Pill } from '../../../../shared/view/ui';
import type { Project } from '../../../../types/app';
import type { WorkspacePanel, WorkspaceTab } from '../../../../types/workspace';
import type { WorkspaceApi } from '../../types/types';
import { usePlugins } from '../../../../contexts/PluginsContext';
import PluginIcon from '../../../plugins/view/PluginIcon';

type WorkspaceTabStripProps = {
  workspace: WorkspaceApi;
  selectedProject: Project;
  shouldShowTasksTab: boolean;
  onCloseTab: (id: string) => void;
  onNewShell: () => void;
};

type PanelDefinition =
  | { kind: 'builtin'; id: WorkspacePanel; labelKey: string; icon: LucideIcon }
  | { kind: 'plugin'; id: WorkspacePanel; label: string; pluginName: string; iconFile: string };

const BASE_PANELS: PanelDefinition[] = [
  { kind: 'builtin', id: 'files', labelKey: 'tabs.files', icon: Folder },
  { kind: 'builtin', id: 'git', labelKey: 'tabs.git', icon: GitBranch },
];

const TASKS_PANEL: PanelDefinition = {
  kind: 'builtin',
  id: 'tasks',
  labelKey: 'tabs.tasks',
  icon: ClipboardCheck,
};

const TAB_ICONS: Record<WorkspaceTab['kind'], LucideIcon> = {
  chat: MessageSquare,
  shell: Terminal,
  file: FileText,
};

/** Resolves a chat tab's live title from project data, falling back to the
 * persisted snapshot so restored tabs render before sessions load. */
function resolveTabTitle(
  tab: WorkspaceTab,
  project: Project,
  newSessionLabel: string,
  shellLabel: string,
): string {
  if (tab.kind === 'file') {
    return tab.name;
  }
  if (tab.kind === 'shell') {
    return tab.title || shellLabel;
  }
  if (!tab.sessionId) {
    return newSessionLabel;
  }
  const sessionLists = [
    project.sessions,
    project.cursorSessions,
    project.codexSessions,
    project.geminiSessions,
    project.opencodeSessions,
  ];
  for (const sessions of sessionLists) {
    const session = sessions?.find((candidate) => candidate.id === tab.sessionId);
    if (session) {
      return (session.summary as string) || (session.name as string) || tab.title || newSessionLabel;
    }
  }
  return tab.title || newSessionLabel;
}

export default function WorkspaceTabStrip({
  workspace,
  selectedProject,
  shouldShowTasksTab,
  onCloseTab,
  onNewShell,
}: WorkspaceTabStripProps) {
  const { t } = useTranslation();
  const { plugins } = usePlugins();

  const builtInPanels = shouldShowTasksTab ? [...BASE_PANELS, TASKS_PANEL] : BASE_PANELS;
  const pluginPanels: PanelDefinition[] = plugins
    .filter((plugin) => plugin.enabled)
    .map((plugin) => ({
      kind: 'plugin',
      id: `plugin:${plugin.name}` as WorkspacePanel,
      label: plugin.displayName,
      pluginName: plugin.name,
      iconFile: plugin.icon,
    }));
  const panels = [...builtInPanels, ...pluginPanels];

  const newSessionLabel = t('mainContent.newSession');
  const shellLabel = t('tabs.shell');

  return (
    <PillBar>
      {workspace.tabs.map((tab) => {
        const isActive = tab.id === workspace.activeId;
        const Icon = TAB_ICONS[tab.kind];
        const title = resolveTabTitle(tab, selectedProject, newSessionLabel, shellLabel);

        return (
          <Tooltip key={tab.id} content={title} position="bottom">
            <Pill
              isActive={isActive}
              onClick={() => workspace.activateTab(tab.id)}
              className="px-2 py-[5px]"
            >
              <Icon className="h-3.5 w-3.5 flex-shrink-0" strokeWidth={isActive ? 2.2 : 1.8} />
              {/* Tab titles stay visible on mobile — that's the point of tabs. */}
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

      <Tooltip content={t('mainContent.newShell', { defaultValue: 'New shell' })} position="bottom">
        <Pill isActive={false} onClick={onNewShell} className="px-2 py-[5px]">
          <Terminal className="h-3.5 w-3.5" strokeWidth={1.8} />
          <Plus className="-ml-1 h-3 w-3" strokeWidth={2.2} />
        </Pill>
      </Tooltip>

      {panels.map((panel) => {
        const isActive = panel.id === workspace.activeId;
        const displayLabel = panel.kind === 'builtin' ? t(panel.labelKey) : panel.label;

        return (
          <Tooltip key={panel.id} content={displayLabel} position="bottom">
            <Pill
              isActive={isActive}
              onClick={() => workspace.activateTab(panel.id)}
              className="px-2.5 py-[5px]"
            >
              {panel.kind === 'builtin' ? (
                <panel.icon className="h-3.5 w-3.5" strokeWidth={isActive ? 2.2 : 1.8} />
              ) : (
                <PluginIcon
                  pluginName={panel.pluginName}
                  iconFile={panel.iconFile}
                  className="flex h-3.5 w-3.5 items-center justify-center [&>svg]:h-full [&>svg]:w-full"
                />
              )}
              <span className="hidden lg:inline">{displayLabel}</span>
            </Pill>
          </Tooltip>
        );
      })}
    </PillBar>
  );
}
