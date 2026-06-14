import CodeMirror from '@uiw/react-codemirror';
import { oneDark } from '@codemirror/theme-one-dark';
import type { Extension } from '@codemirror/state';
import MarkdownPreview from './markdown/MarkdownPreview';
import PlantUmlPreview from './PlantUmlPreview';
import HtmlPreview from './HtmlPreview';
import CustomRenderPreview from './CustomRenderPreview';

type CodeEditorSurfaceProps = {
  content: string;
  onChange: (value: string) => void;
  previewMode: boolean;
  isMarkdownFile: boolean;
  isPlantUmlFile: boolean;
  isHtmlFile: boolean;
  isCustomRenderFile: boolean;
  isDarkMode: boolean;
  fontSize: number;
  showLineNumbers: boolean;
  extensions: Extension[];
  currentFilePath?: string | null;
  projectId?: string;
  onFileOpen?: ((filePath: string) => void) | null;
};

export default function CodeEditorSurface({
  content,
  onChange,
  previewMode,
  isMarkdownFile,
  isPlantUmlFile,
  isHtmlFile,
  isCustomRenderFile,
  isDarkMode,
  fontSize,
  showLineNumbers,
  extensions,
  currentFilePath = null,
  projectId,
  onFileOpen = null,
}: CodeEditorSurfaceProps) {
  if (previewMode && isMarkdownFile) {
    return (
      <div className="h-full overflow-y-auto bg-white dark:bg-gray-900">
        <div className="prose prose-sm mx-auto max-w-4xl max-w-none px-8 py-6 dark:prose-invert prose-headings:font-semibold prose-a:text-blue-600 prose-code:text-sm prose-pre:bg-gray-900 prose-img:rounded-lg dark:prose-a:text-blue-400">
          <MarkdownPreview content={content} currentFilePath={currentFilePath} onFileOpen={onFileOpen} />
        </div>
      </div>
    );
  }

  if (previewMode && isPlantUmlFile) {
    return <PlantUmlPreview content={content} projectId={projectId} path={currentFilePath ?? ''} />;
  }

  if (previewMode && isHtmlFile) {
    return <HtmlPreview projectId={projectId} path={currentFilePath ?? ''} />;
  }

  if (previewMode && isCustomRenderFile) {
    return <CustomRenderPreview content={content} projectId={projectId} path={currentFilePath ?? ''} />;
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
