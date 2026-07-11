import CodeMirror from '@uiw/react-codemirror';
import { oneDark } from '@codemirror/theme-one-dark';
import type { Extension } from '@codemirror/state';
import MarkdownPreview from './markdown/MarkdownPreview';
import PlantUmlPreview from './PlantUmlPreview';
import DbmlPreview from './DbmlPreview';
import HtmlPreview from './HtmlPreview';
import CsvPreview from './CsvPreview';
import CustomRenderPreview from './CustomRenderPreview';
import ApiSpecPreview from './ApiSpecPreview';
import type { ApiSpecKind } from '../../utils/apiSpec';

type CodeEditorSurfaceProps = {
  content: string;
  onChange: (value: string) => void;
  previewMode: boolean;
  isMarkdownFile: boolean;
  isPlantUmlFile: boolean;
  isDbmlFile: boolean;
  isCsvFile?: boolean;
  isHtmlFile: boolean;
  isCustomRenderFile: boolean;
  apiSpecKind?: ApiSpecKind | null;
  isDarkMode: boolean;
  fontSize: number;
  showLineNumbers: boolean;
  extensions: Extension[];
  currentFilePath?: string | null;
  fileName?: string;
  projectId?: string;
  onFileOpen?: ((filePath: string) => void) | null;
};

export default function CodeEditorSurface({
  content,
  onChange,
  previewMode,
  isMarkdownFile,
  isPlantUmlFile,
  isDbmlFile,
  isCsvFile = false,
  isHtmlFile,
  isCustomRenderFile,
  apiSpecKind = null,
  isDarkMode,
  fontSize,
  showLineNumbers,
  extensions,
  currentFilePath = null,
  fileName,
  projectId,
  onFileOpen = null,
}: CodeEditorSurfaceProps) {
  if (previewMode && isMarkdownFile) {
    return (
      <div className="h-full overflow-y-auto bg-background">
        <div className="prose prose-sm mx-auto max-w-4xl max-w-none px-8 py-6 dark:prose-invert prose-headings:font-semibold prose-a:text-blue-600 prose-code:text-sm prose-pre:bg-gray-900 prose-img:rounded-lg dark:prose-a:text-blue-400">
          <MarkdownPreview content={content} currentFilePath={currentFilePath} onFileOpen={onFileOpen} />
        </div>
      </div>
    );
  }

  if (previewMode && isPlantUmlFile) {
    return <PlantUmlPreview content={content} projectId={projectId} path={currentFilePath ?? ''} />;
  }

  if (previewMode && isDbmlFile) {
    return <DbmlPreview content={content} projectId={projectId} path={currentFilePath ?? ''} />;
  }

  if (previewMode && isCsvFile) {
    return <CsvPreview content={content} fileName={fileName} />;
  }

  if (previewMode && isHtmlFile) {
    return <HtmlPreview projectId={projectId} path={currentFilePath ?? ''} />;
  }

  if (previewMode && apiSpecKind) {
    return <ApiSpecPreview content={content} kind={apiSpecKind} />;
  }

  if (previewMode && isCustomRenderFile) {
    return (
      <CustomRenderPreview
        content={content}
        projectId={projectId}
        path={currentFilePath ?? ''}
        onFileOpen={onFileOpen}
      />
    );
  }

  return (
    <CodeMirror
      value={content}
      onChange={onChange}
      extensions={extensions}
      theme={isDarkMode ? oneDark : undefined}
      height="100%"
      style={{
        fontSize: `${fontSize}px`,
        height: '100%',
      }}
      basicSetup={{
        lineNumbers: showLineNumbers,
        foldGutter: true,
        dropCursor: false,
        allowMultipleSelections: false,
        indentOnInput: true,
        bracketMatching: true,
        closeBrackets: true,
        autocompletion: true,
        highlightSelectionMatches: true,
        searchKeymap: true,
      }}
    />
  );
}
