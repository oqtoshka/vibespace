import {
  ClipboardCheck,
  GitBranch,
  MonitorPlay,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Tooltip, Pill } from '../../../../shared/view/ui';
import type { WorkspacePanel } from '../../../../types/workspace';
import type { WorkspaceApi } from '../../types/types';
import { usePlugins } from '../../../../contexts/PluginsContext';
import PluginIcon from '../../../plugins/view/PluginIcon';

type WorkspacePanelBarProps = {
  workspace: WorkspaceApi;
  shouldShowTasksTab: boolean;
};

type PanelDefinition =
  | { kind: 'builtin'; id: WorkspacePanel; labelKey: string; icon: LucideIcon }
  | { kind: 'plugin'; id: WorkspacePanel; label: string; pluginName: string; iconFile: string };

const BASE_PANELS: PanelDefinition[] = [
  { kind: 'builtin', id: 'git', labelKey: 'tabs.git', icon: GitBranch },
  { kind: 'builtin', id: 'browser', labelKey: 'tabs.browser', icon: MonitorPlay },
];

const TASKS_PANEL: PanelDefinition = {
  kind: 'builtin',
  id: 'tasks',
  labelKey: 'tabs.tasks',
  icon: ClipboardCheck,
};

/** Fixed panel toggles in the header's trailing corner: git, tasks, browser,
 * plugins. Icon-only — these don't scroll with the workspace tabs. */
export default function WorkspacePanelBar({
  workspace,
  shouldShowTasksTab,
}: WorkspacePanelBarProps) {
  const { t } = useTranslation();
  const { plugins } = usePlugins();

  const builtInPanels = shouldShowTasksTab ? [...BASE_PANELS, TASKS_PANEL] : BASE_PANELS;
  const pluginPanels: PanelDefinition[] = plugins
    // Headless (hostModule-only) plugins have nothing to show.
    .filter((plugin) => plugin.enabled && plugin.entry)
    .map((plugin) => ({
      kind: 'plugin',
      id: `plugin:${plugin.name}` as WorkspacePanel,
      label: plugin.displayName,
      pluginName: plugin.name,
      iconFile: plugin.icon,
    }));
  const panels = [...builtInPanels, ...pluginPanels];

  return (
    <div className="flex items-center gap-1">
      {panels.map((panel) => {
        const isActive = panel.id === workspace.activeId;
        const displayLabel = panel.kind === 'builtin' ? t(panel.labelKey) : panel.label;

        return (
          <Tooltip key={panel.id} content={displayLabel} position="bottom">
            <Pill
              isActive={isActive}
              onClick={() => (isActive ? workspace.closePanel() : workspace.activateTab(panel.id))}
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
            </Pill>
          </Tooltip>
        );
      })}
    </div>
  );
}
