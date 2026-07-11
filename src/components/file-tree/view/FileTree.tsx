import { useCallback, useMemo, useState, useEffect, useRef } from 'react';
import type { DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, X, Loader2, Folder, Trash2, Upload } from 'lucide-react';

import { cn } from '../../../lib/utils';
import { ICON_SIZE_CLASS, getFileIconData } from '../constants/fileIcons';
import { useExpandedDirectories } from '../hooks/useExpandedDirectories';
import { useFileTreeData } from '../hooks/useFileTreeData';
import { useProjectFilesWatch } from '../../../hooks/useProjectFilesWatch';
import { useFileTreeOperations } from '../hooks/useFileTreeOperations';
import { useFileTreeSearch } from '../hooks/useFileTreeSearch';
import { useFileTreeViewMode } from '../hooks/useFileTreeViewMode';
import { useFileTreeUpload } from '../hooks/useFileTreeUpload';
import {
  FileTreeInteractionsContext,
  INTERNAL_FILE_DND_TYPE,
  type FileTreeInteractions,
} from '../contexts/FileTreeInteractionsContext';
import { api } from '../../../utils/api';
import type { FileTreeNode } from '../types/types';
import { formatFileSize, formatRelativeTime } from '../utils/fileTreeUtils';
import { Project } from '../../../types/app';
import { ScrollArea, Input } from '../../../shared/view/ui';

import FileTreeBody from './FileTreeBody';
import FileTreeDetailedColumns from './FileTreeDetailedColumns';
import FileTreeHeader from './FileTreeHeader';
import FileTreeLoadingState from './FileTreeLoadingState';
import FileTreeUploadProgress from './FileTreeUploadProgress';


type FileTreeProps = {
  selectedProject: Project | null;
  /** Whether the Files tab is currently visible. Defaults to true for standalone usage. */
  isActive?: boolean;
  onFileOpen?: (filePath: string) => void;
};

export default function FileTree({ selectedProject, isActive = true, onFileOpen }: FileTreeProps) {
  const { t } = useTranslation();
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const newItemInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Show toast notification
  const showToast = useCallback((message: string, type: 'success' | 'error') => {
    setToast({ message, type });
  }, []);

  // Auto-hide toast
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  const { expandedDirs, toggleDirectory, expandDirectories, collapseAll } = useExpandedDirectories(
    selectedProject?.projectId,
  );
  const { files, loading, refreshFiles, loadDirectory, ensureFullTree, isFullTreeLoading } =
    useFileTreeData(selectedProject, expandedDirs);

  // The tree stays mounted while other tabs are active; refresh silently when
  // the user returns so the listing is fresh without collapsing expanded dirs.
  const wasActiveRef = useRef(isActive);
  useEffect(() => {
    if (isActive && !wasActiveRef.current) {
      refreshFiles();
    }
    wasActiveRef.current = isActive;
  }, [isActive, refreshFiles]);

  // Auto-refresh from server-pushed filesystem changes. Coalesce bursts and
  // only refetch while the tab is visible — changes that land while it's hidden
  // are picked up by the tab-return refresh above, so we avoid pointless work.
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;
  const refreshDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleAutoRefresh = useCallback(() => {
    if (!isActiveRef.current) {
      return;
    }
    if (refreshDebounceRef.current) {
      clearTimeout(refreshDebounceRef.current);
    }
    refreshDebounceRef.current = setTimeout(() => {
      refreshDebounceRef.current = null;
      refreshFiles();
    }, 400);
  }, [refreshFiles]);
  useEffect(
    () => () => {
      if (refreshDebounceRef.current) {
        clearTimeout(refreshDebounceRef.current);
      }
    },
    [],
  );
  useProjectFilesWatch(selectedProject?.projectId, scheduleAutoRefresh);

  const { viewMode, changeViewMode } = useFileTreeViewMode();
  const { searchQuery, setSearchQuery, filteredFiles } = useFileTreeSearch({
    files,
    expandDirectories,
    ensureFullTree,
  });

  // File operations
  const operations = useFileTreeOperations({
    selectedProject,
    onRefresh: refreshFiles,
    showToast,
  });

  // Moves triggered by dragging the tree's own rows onto a folder.
  const handleMoveNodes = useCallback(
    async (sourcePaths: string[], targetDir: string) => {
      if (!selectedProject || sourcePaths.length === 0) return;
      // Drop entries whose ancestor is also being moved — the ancestor's move
      // carries them along, and moving them twice can only fail.
      const roots = sourcePaths.filter(
        (candidate) => !sourcePaths.some((other) => other !== candidate && candidate.startsWith(`${other}/`)),
      );
      try {
        const response = await api.moveFiles(selectedProject.projectId, { sourcePaths: roots, targetDir });
        const data = await response.json() as {
          error?: string;
          moved?: unknown[];
          failed?: Array<{ path: string; error: string }>;
        };
        if (!response.ok) {
          throw new Error(data.error || 'Failed to move');
        }
        const failed = data.failed ?? [];
        if (failed.length > 0) {
          showToast(failed.map((f) => f.error)[0] + (failed.length > 1 ? ` (+${failed.length - 1} more)` : ''), 'error');
        } else {
          const count = data.moved?.length ?? roots.length;
          showToast(t('fileTree.toast.moved', 'Moved {{count}} item(s)', { count }), 'success');
        }
        refreshFiles();
      } catch (err) {
        showToast((err as Error).message, 'error');
      }
    },
    [refreshFiles, selectedProject, showToast, t],
  );

  // File upload (drag and drop)
  const upload = useFileTreeUpload({
    selectedProject,
    onRefresh: refreshFiles,
    showToast,
    onMoveNodes: handleMoveNodes,
  });
  const operationLoading = operations.operationLoading || upload.operationLoading;

  /* ------------------------------------------------------------------ */
  /*  Row drag-and-drop + checkbox multi-select                          */
  /* ------------------------------------------------------------------ */
  const [draggingPaths, setDraggingPaths] = useState<string[] | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const { setDropTarget } = upload;

  const toggleSelectionMode = useCallback(() => {
    setSelectionMode((current) => {
      if (current) setSelectedPaths(new Set());
      return !current;
    });
  }, []);

  const parentDirOf = (itemPath: string) => itemPath.split('/').slice(0, -1).join('/');

  const interactions = useMemo<FileTreeInteractions>(() => ({
    dropTarget: upload.dropTarget,
    isInternalDrag: draggingPaths !== null,
    onNodeDragStart: (event: DragEvent, item) => {
      // Dragging a selected row moves the whole selection; any other row
      // moves just itself.
      const paths = selectionMode && selectedPaths.has(item.path) ? [...selectedPaths] : [item.path];
      event.dataTransfer.setData(INTERNAL_FILE_DND_TYPE, JSON.stringify(paths));
      event.dataTransfer.effectAllowed = 'move';
      setDraggingPaths(paths);
    },
    onNodeDragEnd: () => {
      setDraggingPaths(null);
      setDropTarget(null);
    },
    onNodeDragOver: (event: DragEvent, item) => {
      event.preventDefault();
      // Rows own the drop target; the container's dragover (empty space)
      // resets it to the project root.
      event.stopPropagation();
      const target = item.type === 'directory' ? item.path : parentDirOf(item.path);
      // Don't offer a dragged folder as its own destination.
      if (draggingPaths?.includes(target)) {
        setDropTarget(null);
        return;
      }
      setDropTarget(target);
    },
    selectionMode,
    selectedPaths,
    toggleSelected: (item) => {
      setSelectedPaths((current) => {
        const next = new Set(current);
        if (next.has(item.path)) {
          next.delete(item.path);
        } else {
          next.add(item.path);
        }
        return next;
      });
    },
  }), [draggingPaths, selectedPaths, selectionMode, setDropTarget, upload.dropTarget]);

  const handleBulkDelete = useCallback(async () => {
    if (!selectedProject || selectedPaths.size === 0) return;
    // Skip paths whose ancestor is also selected — deleting the ancestor
    // removes them anyway.
    const paths = [...selectedPaths].filter(
      (candidate) => ![...selectedPaths].some((other) => other !== candidate && candidate.startsWith(`${other}/`)),
    );
    let failures = 0;
    for (const targetPath of paths) {
      try {
        const response = await api.deleteFile(selectedProject.projectId, { path: targetPath, type: 'file' });
        if (!response.ok) failures += 1;
      } catch {
        failures += 1;
      }
    }
    setBulkDeleteOpen(false);
    setSelectedPaths(new Set());
    setSelectionMode(false);
    refreshFiles();
    showToast(
      failures > 0
        ? t('fileTree.toast.bulkDeletePartial', 'Deleted {{ok}} of {{total}} items', { ok: paths.length - failures, total: paths.length })
        : t('fileTree.toast.bulkDeleted', 'Deleted {{count}} item(s)', { count: paths.length }),
      failures > 0 ? 'error' : 'success',
    );
  }, [refreshFiles, selectedPaths, selectedProject, showToast, t]);

  // Focus input when creating new item
  useEffect(() => {
    if (operations.isCreating && newItemInputRef.current) {
      newItemInputRef.current.focus();
      newItemInputRef.current.select();
    }
  }, [operations.isCreating]);

  // Focus input when renaming
  useEffect(() => {
    if (operations.renamingItem && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [operations.renamingItem]);

  const renderFileIcon = useCallback((filename: string) => {
    const { icon: Icon, color } = getFileIconData(filename);
    return <Icon className={cn(ICON_SIZE_CLASS, color)} />;
  }, []);

  // Centralized click behavior keeps file actions identical across all presentation modes.
  const handleItemClick = useCallback(
    (item: FileTreeNode) => {
      if (item.type === 'directory') {
        // Lazily fetch children the first time a directory is expanded
        // (`children === undefined` means the subtree was never loaded).
        if (!expandedDirs.has(item.path) && item.children === undefined) {
          loadDirectory(item.path);
        }
        toggleDirectory(item.path);
        return;
      }

      onFileOpen?.(item.path);
    },
    [expandedDirs, loadDirectory, onFileOpen, toggleDirectory],
  );

  const formatRelativeTimeLabel = useCallback(
    (date?: string) => formatRelativeTime(date, t),
    [t],
  );

  // Only blank the view on the initial load; background refreshes keep the
  // current tree visible until fresh data lands.
  if (loading && files.length === 0) {
    return <FileTreeLoadingState />;
  }

  return (
    <div
      ref={upload.treeRef}
      className="relative flex h-full flex-col bg-background"
      onDragEnter={upload.handleDragEnter}
      onDragOver={upload.handleDragOver}
      onDragLeave={upload.handleDragLeave}
      onDrop={upload.handleDrop}
    >
      {/* Drag overlay — pointer-events-none so folder rows still receive
          dragover and can claim the drop target; hidden for internal moves
          where the row highlight is the only cue needed. */}
      {upload.isDragOver && !draggingPaths && (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-end justify-center border-2 border-dashed border-blue-500 bg-blue-500/5 pb-6">
          <div className="flex items-center gap-3 rounded-lg bg-background/95 px-6 py-3 shadow-lg">
            <Upload className="h-5 w-5 text-blue-500" />
            <span className="text-sm font-medium">
              {upload.dropTarget
                ? t('fileTree.dropToUploadInto', 'Drop to upload into {{folder}}', {
                    folder: upload.dropTarget.split('/').pop(),
                  })
                : t('fileTree.dropToUpload', 'Drop files to upload')}
            </span>
          </div>
        </div>
      )}

      <FileTreeHeader
        viewMode={viewMode}
        onViewModeChange={changeViewMode}
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
        onUploadFiles={upload.handleFileSelect}
        onNewFile={() => operations.handleStartCreate('', 'file')}
        onNewFolder={() => operations.handleStartCreate('', 'directory')}
        onRefresh={refreshFiles}
        onCollapseAll={collapseAll}
        selectionMode={selectionMode}
        onToggleSelectionMode={toggleSelectionMode}
        loading={loading || isFullTreeLoading}
        operationLoading={operationLoading}
        isUploading={upload.uploadProgress?.status === 'uploading'}
        uploadProgress={upload.uploadProgress?.progress ?? null}
      />

      <FileTreeUploadProgress upload={upload.uploadProgress} />

      {selectionMode && (
        <div className="flex items-center justify-between border-b border-border/60 bg-accent/30 px-3 py-1.5">
          <span className="text-xs text-muted-foreground">
            {t('fileTree.selectedCount', '{{count}} selected', { count: selectedPaths.size })}
          </span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setBulkDeleteOpen(true)}
              disabled={selectedPaths.size === 0 || operationLoading}
              className="flex items-center gap-1 rounded-md bg-red-600 px-2 py-1 text-xs text-white transition-colors hover:bg-red-700 disabled:opacity-50"
            >
              <Trash2 className="h-3 w-3" />
              {t('fileTree.deleteSelected', 'Delete')}
            </button>
            <button
              type="button"
              onClick={toggleSelectionMode}
              className="rounded-md px-2 py-1 text-xs transition-colors hover:bg-accent"
            >
              {t('common.cancel', 'Cancel')}
            </button>
          </div>
        </div>
      )}

      {viewMode === 'detailed' && filteredFiles.length > 0 && <FileTreeDetailedColumns />}

      <ScrollArea className="flex-1 px-2 py-1">
        {/* New item input */}
        {operations.isCreating && (
          <div
            className="mb-1 flex items-center gap-1.5 py-[3px] pr-2"
            style={{ paddingLeft: `${(operations.newItemParent.split('/').length - 1) * 16 + 4}px` }}
          >
            {operations.newItemType === 'directory' ? (
              <Folder className={cn(ICON_SIZE_CLASS, 'text-blue-500')} />
            ) : (
              <span className="ml-[18px]">{renderFileIcon(operations.newItemName)}</span>
            )}
            <Input
              ref={newItemInputRef}
              type="text"
              value={operations.newItemName}
              onChange={(e) => operations.setNewItemName(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') operations.handleConfirmCreate();
                if (e.key === 'Escape') operations.handleCancelCreate();
              }}
              onBlur={() => {
                setTimeout(() => {
                  if (operations.isCreating) operations.handleConfirmCreate();
                }, 100);
              }}
              className="h-6 flex-1 text-sm"
              disabled={operationLoading}
            />
          </div>
        )}

        <FileTreeInteractionsContext.Provider value={interactions}>
        <FileTreeBody
          files={files}
          filteredFiles={filteredFiles}
          searchQuery={searchQuery}
          viewMode={viewMode}
          expandedDirs={expandedDirs}
          onItemClick={handleItemClick}
          renderFileIcon={renderFileIcon}
          formatFileSize={formatFileSize}
          formatRelativeTime={formatRelativeTimeLabel}
          onRename={operations.handleStartRename}
          onDelete={operations.handleStartDelete}
          onNewFile={(path) => operations.handleStartCreate(path, 'file')}
          onNewFolder={(path) => operations.handleStartCreate(path, 'directory')}
          onCopyPath={operations.handleCopyPath}
          onDownload={operations.handleDownload}
          onRefresh={refreshFiles}
          // Pass rename state and handlers for inline editing
          renamingItem={operations.renamingItem}
          renameValue={operations.renameValue}
          setRenameValue={operations.setRenameValue}
          handleConfirmRename={operations.handleConfirmRename}
          handleCancelRename={operations.handleCancelRename}
          renameInputRef={renameInputRef}
          operationLoading={operationLoading}
        />
        </FileTreeInteractionsContext.Provider>
      </ScrollArea>

      {/* Delete Confirmation Dialog */}
      {operations.deleteConfirmation.isOpen && operations.deleteConfirmation.item && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50">
          <div className="mx-4 max-w-sm rounded-lg border border-border bg-background p-4 shadow-lg">
            <div className="mb-4 flex items-center gap-3">
              <div className="rounded-full bg-red-100 p-2 dark:bg-red-900/30">
                <AlertTriangle className="h-5 w-5 text-red-600 dark:text-red-400" />
              </div>
              <div>
                <h3 className="font-medium text-foreground">
                  {t('fileTree.delete.title', 'Delete {{type}}', {
                    type: operations.deleteConfirmation.item.type === 'directory' ? 'Folder' : 'File'
                  })}
                </h3>
                <p className="text-sm text-muted-foreground">
                  {operations.deleteConfirmation.item.name}
                </p>
              </div>
            </div>
            <p className="mb-4 text-sm text-muted-foreground">
              {operations.deleteConfirmation.item.type === 'directory'
                ? t('fileTree.delete.folderWarning', 'This folder and all its contents will be permanently deleted.')
                : t('fileTree.delete.fileWarning', 'This file will be permanently deleted.')}
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={operations.handleCancelDelete}
                disabled={operationLoading}
                className="rounded-md px-3 py-1.5 text-sm transition-colors hover:bg-accent"
              >
                {t('common.cancel', 'Cancel')}
              </button>
              <button
                onClick={operations.handleConfirmDelete}
                disabled={operationLoading}
                className="flex items-center gap-2 rounded-md bg-red-600 px-3 py-1.5 text-sm text-white transition-colors hover:bg-red-700 disabled:opacity-50"
              >
                {operationLoading && <Loader2 className="h-4 w-4 animate-spin" />}
                {t('fileTree.delete.confirm', 'Delete')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk Delete Confirmation Dialog */}
      {bulkDeleteOpen && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50">
          <div className="mx-4 max-w-sm rounded-lg border border-border bg-background p-4 shadow-lg">
            <div className="mb-4 flex items-center gap-3">
              <div className="rounded-full bg-red-100 p-2 dark:bg-red-900/30">
                <AlertTriangle className="h-5 w-5 text-red-600 dark:text-red-400" />
              </div>
              <h3 className="font-medium text-foreground">
                {t('fileTree.bulkDelete.title', 'Delete {{count}} item(s)', { count: selectedPaths.size })}
              </h3>
            </div>
            <p className="mb-4 text-sm text-muted-foreground">
              {t('fileTree.bulkDelete.warning', 'The selected files and folders (including their contents) will be permanently deleted.')}
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setBulkDeleteOpen(false)}
                disabled={operationLoading}
                className="rounded-md px-3 py-1.5 text-sm transition-colors hover:bg-accent"
              >
                {t('common.cancel', 'Cancel')}
              </button>
              <button
                onClick={handleBulkDelete}
                disabled={operationLoading}
                className="flex items-center gap-2 rounded-md bg-red-600 px-3 py-1.5 text-sm text-white transition-colors hover:bg-red-700 disabled:opacity-50"
              >
                {operationLoading && <Loader2 className="h-4 w-4 animate-spin" />}
                {t('fileTree.delete.confirm', 'Delete')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast Notification */}
      {toast && (
        <div
          className={cn(
            'fixed bottom-4 right-4 z-[9999] px-4 py-2 rounded-lg shadow-lg flex items-center gap-2 animate-in slide-in-from-bottom-2',
            toast.type === 'success'
              ? 'bg-green-600 text-white'
              : 'bg-red-600 text-white'
          )}
        >
          {toast.type === 'success' ? (
            <Check className="h-4 w-4" />
          ) : (
            <X className="h-4 w-4" />
          )}
          <span className="text-sm">{toast.message}</span>
        </div>
      )}
    </div>
  );
}
