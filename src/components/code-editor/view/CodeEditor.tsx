import { EditorView } from '@codemirror/view';
import { unifiedMergeView } from '@codemirror/merge';
import type { Extension } from '@codemirror/state';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePaletteOps } from '../../../contexts/PaletteOpsContext';
import { useTheme } from '../../../contexts/ThemeContext';
import { useCodeEditorDocument } from '../hooks/useCodeEditorDocument';
import { useCodeEditorSettings } from '../hooks/useCodeEditorSettings';
import { useEditorKeyboardShortcuts } from '../hooks/useEditorKeyboardShortcuts';
import type { CodeEditorFile } from '../types/types';
import { createMinimapExtension, createScrollToFirstChunkExtension, getLanguageExtensions } from '../utils/editorExtensions';
import { getEditorStyles } from '../utils/editorStyles';
import { createEditorToolbarPanelExtension } from '../utils/editorToolbarPanel';
import CodeEditorFooter from './subcomponents/CodeEditorFooter';
import CodeEditorHeader from './subcomponents/CodeEditorHeader';
import CodeEditorLoadingState from './subcomponents/CodeEditorLoadingState';
import CodeEditorSurface from './subcomponents/CodeEditorSurface';
import CodeEditorBinaryFile from './subcomponents/CodeEditorBinaryFile';
import CodeEditorPdfView from './subcomponents/CodeEditorPdfView';
import CodeEditorImageView from './subcomponents/CodeEditorImageView';
import { isImageFile } from '../utils/binaryFile';
import { detectApiSpecKind } from '../utils/apiSpec';

type CodeEditorProps = {
  file: CodeEditorFile;
  onClose: () => void;
  projectPath?: string;
  isSidebar?: boolean;
  isExpanded?: boolean;
  onToggleExpand?: (() => void) | null;
  onPopOut?: (() => void) | null;
  /** Opens another in-project file (markdown preview relative-link jumps). */
  onFileOpen?: ((filePath: string) => void) | null;
};

export default function CodeEditor({
  file,
  onClose,
  projectPath,
  isSidebar = false,
  isExpanded = false,
  onToggleExpand = null,
  onPopOut = null,
  onFileOpen = null,
}: CodeEditorProps) {
  const { t } = useTranslation('codeEditor');
  const paletteOps = usePaletteOps();
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showDiff, setShowDiff] = useState(Boolean(file.diffInfo));

  const isMarkdownFile = useMemo(() => {
    const extension = file.name.split('.').pop()?.toLowerCase();
    return extension === 'md' || extension === 'markdown';
  }, [file.name]);

  const isPlantUmlFile = useMemo(() => {
    const extension = file.name.split('.').pop()?.toLowerCase();
    return extension === 'puml' || extension === 'plantuml' || extension === 'iuml' || extension === 'wsd';
  }, [file.name]);

  const isHtmlFile = useMemo(() => {
    const extension = file.name.split('.').pop()?.toLowerCase();
    return extension === 'html' || extension === 'htm';
  }, [file.name]);

  const isDbmlFile = useMemo(() => {
    const extension = file.name.split('.').pop()?.toLowerCase();
    return extension === 'dbml';
  }, [file.name]);

  const isCsvFile = useMemo(() => {
    const extension = file.name.split('.').pop()?.toLowerCase();
    return extension === 'csv' || extension === 'tsv';
  }, [file.name]);

  const isPdfFile = useMemo(() => {
    const extension = file.name.split('.').pop()?.toLowerCase();
    return extension === 'pdf';
  }, [file.name]);

  const isImage = useMemo(() => isImageFile(file.name), [file.name]);

  // Custom formats with a project renderer (e.g. *.flow.json → flow diagram).
  const isCustomRenderFile = useMemo(() => file.name.toLowerCase().endsWith('.flow.json'), [file.name]);

  // Theme moved to the app-wide ThemeContext; the editor-settings hook now
  // only owns editor-local preferences (wrap, minimap, line numbers, font).
  const { isDarkMode } = useTheme();
  const {
    wordWrap,
    minimapEnabled,
    showLineNumbers,
    fontSize,
  } = useCodeEditorSettings();

  const {
    content,
    setContent,
    loading,
    saving,
    saveSuccess,
    saveError,
    isBinary,
    handleSave,
    handleDownload,
  } = useCodeEditorDocument({
    file,
    projectPath,
  });

  // OpenAPI/Swagger/AsyncAPI documents are plain .yaml/.yml/.json files, so
  // detection sniffs the loaded content rather than the extension.
  const apiSpecKind = useMemo(() => detectApiSpecKind(file.name, content), [file.name, content]);

  const isPreviewable = isMarkdownFile || isPlantUmlFile || isHtmlFile || isCustomRenderFile || isDbmlFile || isCsvFile || apiSpecKind !== null;

  // Default previewable files (markdown, PlantUML, HTML) to their rendered
  // preview when opened normally — via the file tree or a markdown link jump.
  // A diff view (git/quick-diff) opens in the editor so the changes are visible.
  const [previewMode, setPreviewMode] = useState(() => isPreviewable && !file.diffInfo);

  // Spec detection can't feed the initializer above — content arrives after
  // mount — so flip the preview on once when a spec is recognized, without
  // fighting a later manual toggle back to the editor.
  const specAutoPreviewed = useRef(false);
  useEffect(() => {
    if (apiSpecKind && !specAutoPreviewed.current) {
      specAutoPreviewed.current = true;
      if (!file.diffInfo) {
        setPreviewMode(true);
      }
    }
  }, [apiSpecKind, file.diffInfo]);

  const minimapExtension = useMemo(
    () => (
      createMinimapExtension({
        file,
        showDiff,
        minimapEnabled,
        isDarkMode,
      })
    ),
    [file, isDarkMode, minimapEnabled, showDiff],
  );

  const scrollToFirstChunkExtension = useMemo(
    () => createScrollToFirstChunkExtension({ file, showDiff }),
    [file, showDiff],
  );

  const toolbarPanelExtension = useMemo(
    () => (
      createEditorToolbarPanelExtension({
        file,
        showDiff,
        isSidebar,
        isExpanded,
        onToggleDiff: () => setShowDiff((previous) => !previous),
        onPopOut,
        onToggleExpand,
        labels: {
          changes: t('toolbar.changes'),
          previousChange: t('toolbar.previousChange'),
          nextChange: t('toolbar.nextChange'),
          hideDiff: t('toolbar.hideDiff'),
          showDiff: t('toolbar.showDiff'),
          collapse: t('toolbar.collapse'),
          expand: t('toolbar.expand'),
        },
      })
    ),
    [file, isExpanded, isSidebar, onPopOut, onToggleExpand, showDiff, t],
  );

  const extensions = useMemo(() => {
    const allExtensions: Extension[] = [
      ...getLanguageExtensions(file.name),
      ...toolbarPanelExtension,
    ];

    if (file.diffInfo && showDiff && file.diffInfo.old_string !== undefined) {
      allExtensions.push(
        unifiedMergeView({
          original: file.diffInfo.old_string,
          mergeControls: false,
          highlightChanges: true,
          syntaxHighlightDeletions: false,
          gutter: true,
        }),
      );
      allExtensions.push(...minimapExtension);
      allExtensions.push(...scrollToFirstChunkExtension);
    }

    if (wordWrap) {
      allExtensions.push(EditorView.lineWrapping);
    }

    return allExtensions;
  }, [
    file.diffInfo,
    file.name,
    minimapExtension,
    scrollToFirstChunkExtension,
    showDiff,
    toolbarPanelExtension,
    wordWrap,
  ]);

  useEditorKeyboardShortcuts({
    onSave: handleSave,
    onClose,
    dependency: content,
  });

  if (loading) {
    return (
      <CodeEditorLoadingState
        isDarkMode={isDarkMode}
        isSidebar={isSidebar}
        loadingText={t('loading', { fileName: file.name })}
      />
    );
  }

  // PDFs are detected as binary (so no text read happens) but render inline in
  // the browser's native PDF viewer rather than the "cannot be displayed" screen.
  if (isBinary && isPdfFile) {
    return (
      <CodeEditorPdfView
        file={file}
        isSidebar={isSidebar}
        isFullscreen={isFullscreen}
        onClose={onClose}
        onToggleFullscreen={() => setIsFullscreen((previous) => !previous)}
      />
    );
  }

  // Images render inline in their own viewer rather than the "cannot be
  // displayed" binary screen. They're flagged binary so no text read happens.
  if (isBinary && isImage) {
    return (
      <CodeEditorImageView
        file={file}
        isSidebar={isSidebar}
        isFullscreen={isFullscreen}
        onClose={onClose}
        onToggleFullscreen={() => setIsFullscreen((previous) => !previous)}
      />
    );
  }

  // Binary file display
  if (isBinary) {
    return (
      <CodeEditorBinaryFile
        file={file}
        isSidebar={isSidebar}
        isFullscreen={isFullscreen}
        onClose={onClose}
        onToggleFullscreen={() => setIsFullscreen((previous) => !previous)}
        title={t('binaryFile.title', 'Binary File')}
        message={t('binaryFile.message', 'The file "{{fileName}}" cannot be displayed in the text editor because it is a binary file.', { fileName: file.name })}
      />
    );
  }

  const outerContainerClassName = isSidebar
    ? 'w-full h-full flex flex-col'
    : `fixed inset-0 z-[9999] md:bg-black/50 md:flex md:items-center md:justify-center md:p-4 ${isFullscreen ? 'md:p-0' : ''}`;

  const innerContainerClassName = isSidebar
    ? 'bg-background flex flex-col w-full h-full'
    : `bg-background shadow-2xl flex flex-col w-full h-full md:rounded-lg md:shadow-2xl${
      isFullscreen ? ' md:w-full md:h-full md:rounded-none' : ' md:w-full md:max-w-6xl md:h-[80vh] md:max-h-[80vh]'
    }`;

  return (
    <>
      <style>{getEditorStyles(isDarkMode)}</style>
      <div className={outerContainerClassName}>
        <div className={innerContainerClassName}>
          <CodeEditorHeader
            file={file}
            projectPath={projectPath}
            onFileOpen={onFileOpen}
            isSidebar={isSidebar}
            isFullscreen={isFullscreen}
            isPreviewable={isPreviewable}
            previewMode={previewMode}
            saving={saving}
            saveSuccess={saveSuccess}
            onTogglePreview={() => setPreviewMode((previous) => !previous)}
            onOpenSettings={() => paletteOps.openSettings('appearance')}
            onDownload={handleDownload}
            onSave={handleSave}
            onToggleFullscreen={() => setIsFullscreen((previous) => !previous)}
            onClose={onClose}
            labels={{
              showingChanges: t('header.showingChanges'),
              edit: t('actions.edit', 'Edit'),
              preview: t('actions.preview', 'Preview'),
              copyPath: t('actions.copyPath', 'Copy file path'),
              pathCopied: t('actions.pathCopied', 'File path copied'),
              settings: t('toolbar.settings'),
              download: t('actions.download'),
              save: t('actions.save'),
              saving: t('actions.saving'),
              saved: t('actions.saved'),
              fullscreen: t('actions.fullscreen'),
              exitFullscreen: t('actions.exitFullscreen'),
              close: t('actions.close'),
            }}
          />

          {saveError && (
            <div className="border-b border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-700 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-300">
              {saveError}
            </div>
          )}

          <div className="flex-1 overflow-hidden">
            <CodeEditorSurface
              content={content}
              onChange={setContent}
              previewMode={previewMode}
              isMarkdownFile={isMarkdownFile}
              isPlantUmlFile={isPlantUmlFile}
              isDbmlFile={isDbmlFile}
              isCsvFile={isCsvFile}
              isHtmlFile={isHtmlFile}
              isCustomRenderFile={isCustomRenderFile}
              apiSpecKind={apiSpecKind}
              isDarkMode={isDarkMode}
              fontSize={fontSize}
              showLineNumbers={showLineNumbers}
              extensions={extensions}
              currentFilePath={file.path}
              fileName={file.name}
              projectId={file.projectId}
              onFileOpen={onFileOpen}
            />
          </div>

          <CodeEditorFooter
            content={content}
            linesLabel={t('footer.lines')}
            charactersLabel={t('footer.characters')}
            shortcutsLabel={t('footer.shortcuts')}
          />
        </div>
      </div>
    </>
  );
}
