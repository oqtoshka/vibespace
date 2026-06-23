import type { CodeEditorDiffInfo } from '../components/code-editor/types/types';

/**
 * Panels are singleton views (Git/Tasks/Preview/plugins) selected from the
 * pill bar; they are not closable tabs. Their ids share one selection space
 * with workspace tab ids (`tab_*`), discriminated by `isPanelId`. The file
 * tree is NOT a panel — it's a docked, toggleable explorer pane rendered
 * alongside whatever is active (VSCode-style).
 */
export type WorkspacePanel = 'git' | 'tasks' | 'preview' | 'browser' | `plugin:${string}`;

/**
 * A persistent workspace tab. Only files become tabs — chat and terminal live
 * in the dedicated session pane (toggled per session), not the tab strip.
 * File tabs are kept-mounted CodeEditor instances.
 */
export type WorkspaceTab = {
  id: string;
  kind: 'file';
  path: string;
  name: string;
  diffInfo?: CodeEditorDiffInfo | null;
};

export type WorkspaceTabKind = WorkspaceTab['kind'];

const PANEL_IDS: ReadonlySet<string> = new Set(['git', 'tasks', 'preview', 'browser']);

export function isPanelId(id: string): id is WorkspacePanel {
  return PANEL_IDS.has(id) || id.startsWith('plugin:');
}
