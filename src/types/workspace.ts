import type { CodeEditorDiffInfo } from '../components/code-editor/types/types';
import type { LLMProvider } from './app';

/**
 * Panels are singleton views (Git/Tasks/Preview/plugins) selected from the
 * pill bar; they are not closable tabs. Their ids share one selection space
 * with workspace tab ids (`tab_*`), discriminated by `isPanelId`. The file
 * tree is NOT a panel — it's a docked, toggleable explorer pane rendered
 * alongside whatever is active (VSCode-style).
 */
export type WorkspacePanel = 'git' | 'tasks' | 'preview' | `plugin:${string}`;

/**
 * A persistent workspace tab. Chat tabs are pointers into the single mounted
 * ChatInterface; shell tabs are live Shell instances (one PTY each); file
 * tabs are kept-mounted CodeEditor instances.
 */
export type WorkspaceTab =
  | {
    id: string;
    kind: 'chat';
    /** `null` marks the pending "New session" tab awaiting adoption. */
    sessionId: string | null;
    provider?: LLMProvider;
    /** Title snapshot so the tab renders before project data loads. */
    title?: string;
  }
  | {
    id: string;
    kind: 'shell';
    /** Stable client-generated id; part of the server PTY session key. */
    shellId: string;
    sessionId: string | null;
    provider?: LLMProvider;
    title?: string;
  }
  | {
    id: string;
    kind: 'file';
    path: string;
    name: string;
    diffInfo?: CodeEditorDiffInfo | null;
  };

export type WorkspaceTabKind = WorkspaceTab['kind'];

const PANEL_IDS: ReadonlySet<string> = new Set(['git', 'tasks', 'preview']);

export function isPanelId(id: string): id is WorkspacePanel {
  return PANEL_IDS.has(id) || id.startsWith('plugin:');
}
