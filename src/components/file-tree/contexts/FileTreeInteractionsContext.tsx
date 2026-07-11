import { createContext, useContext } from 'react';
import type { DragEvent } from 'react';

import type { FileTreeNode } from '../types/types';

/**
 * DataTransfer type marking an in-tree drag (moving files/folders between
 * directories) so drops can be told apart from OS file uploads. The payload is
 * a JSON array of absolute source paths.
 */
export const INTERNAL_FILE_DND_TYPE = 'application/x-vibespace-tree-nodes';

/**
 * Drag-and-drop + multi-select state shared by every tree row. Provided by
 * FileTree and consumed directly in FileTreeNode — a context instead of props
 * because the rows are reached through Body → List → Node recursion.
 */
export type FileTreeInteractions = {
  /** Directory path uploads/moves would land in right now (null = none, '' = project root). */
  dropTarget: string | null;
  /** True while one of the tree's own rows is being dragged. */
  isInternalDrag: boolean;
  onNodeDragStart: (event: DragEvent, item: FileTreeNode) => void;
  onNodeDragEnd: () => void;
  onNodeDragOver: (event: DragEvent, item: FileTreeNode) => void;

  /** Checkbox multi-select for bulk actions. */
  selectionMode: boolean;
  selectedPaths: Set<string>;
  toggleSelected: (item: FileTreeNode) => void;
};

const noop = () => {};

const defaultInteractions: FileTreeInteractions = {
  dropTarget: null,
  isInternalDrag: false,
  onNodeDragStart: noop,
  onNodeDragEnd: noop,
  onNodeDragOver: noop,
  selectionMode: false,
  selectedPaths: new Set(),
  toggleSelected: noop,
};

export const FileTreeInteractionsContext = createContext<FileTreeInteractions>(defaultInteractions);

export const useFileTreeInteractions = () => useContext(FileTreeInteractionsContext);
