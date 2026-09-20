import React, { Component, type ErrorInfo, type ReactNode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { setNativeViewerTransport } from '../utils/api';
import { NativePreviewEventsProvider } from '../contexts/WebSocketContext';
import { NativeThemeProvider, useTheme } from '../contexts/ThemeContext';
import CodeEditorSurface from '../components/code-editor/view/subcomponents/CodeEditorSurface';
import CodeEditorImageView from '../components/code-editor/view/subcomponents/CodeEditorImageView';
import CodeEditorPdfView from '../components/code-editor/view/subcomponents/CodeEditorPdfView';
import CodeEditorMediaPreview from '../components/code-editor/view/subcomponents/CodeEditorMediaPreview';
import { getPreviewKind } from '../components/code-editor/utils/previewableFile';
import { detectApiSpecKind } from '../components/code-editor/utils/apiSpec';
import '../index.css';
import 'katex/dist/katex.min.css';
import '../i18n/config.js';
import './style.css';

type Document = { projectId: string; path: string; name: string; content: string; source: boolean; version: string; customRenderer?: boolean };
type NativeResult = { base64?: string; mime?: string; [key: string]: unknown };
declare global {
  interface Window {
    webkit?: { messageHandlers: { workspace: { postMessage: (value: unknown) => Promise<NativeResult> } } };
    mcOpen: (file: Document) => void;
    mcChanged: () => void;
    mcSuspend: () => void;
  }
}
let current: Document | null = null;
const call = async (payload: Record<string, unknown>) => {
  if (!window.webkit) throw new Error('The native workspace is unavailable');
  return window.webkit.messageHandlers.workspace.postMessage(payload);
};
const bytes = (base64: string) => Uint8Array.from(atob(base64), c => c.charCodeAt(0));
setNativeViewerTransport(async (url: string, options: RequestInit = {}) => {
  if (!current) throw new Error('No open document');
  const parsed = new URL(url, 'https://viewer.invalid');
  const prefix = '/api/projects/' + encodeURIComponent(current.projectId);
  if (parsed.pathname === '/api/plantuml') {
    const body = JSON.parse(String(options.body || '{}'));
    const value = await call({ op: 'render', kind: 'inline-plantuml', path: current.path, content: body.content, projectId: current.projectId });
    return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  }
  if (!parsed.pathname.startsWith(prefix + '/')) throw new Error('Unsupported preview request');
  const suffix = parsed.pathname.slice(prefix.length);
  const body = options.body ? JSON.parse(String(options.body)) : {};
  const path = body.path || parsed.searchParams.get('path') || parsed.searchParams.get('filePath') || current.path;
  let payload: Record<string, unknown>;
  if (suffix === '/files/content' || suffix === '/file') payload = { op: 'read', path };
  else if (suffix === '/html-preview') payload = { op: 'html', path };
  else if (suffix === '/plantuml' || suffix === '/dbml' || suffix === '/render-custom') {
    payload = { op: 'render', path, kind: suffix === '/render-custom' ? 'custom' : suffix.slice(1) };
  } else throw new Error('Unsupported preview request');
  try {
    const value = await call({ ...payload, projectId: current.projectId });
    if (suffix === '/file') return new Response(JSON.stringify({ content: new TextDecoder().decode(bytes(value.base64 || '')) }), { headers: { 'content-type': 'application/json' } });
    if (suffix === '/files/content') return new Response(bytes(value.base64 || ''), { headers: { 'content-type': value.mime || 'application/octet-stream' } });
    return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), { status: 400, headers: { 'content-type': 'application/json' } });
  }
});

class PreviewErrorBoundary extends Component<{ document: Document; children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Native file preview failed', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return <div className="native-render-error" role="alert">
      <strong>Preview failed. Showing the file source instead.</strong>
      <span>{this.props.document.name}: {this.state.error}</span>
      <pre className="native-source">{this.props.document.content}</pre>
    </div>;
  }
}

function DocumentPreview({ document, revision }: { document: Document; revision: number }) {
  const { isDarkMode } = useTheme();
  const file = { name: document.name, path: document.path, projectId: document.projectId };
  const ext = document.name.split('.').pop()?.toLowerCase() || '';
  const onClose = () => { void call({ op: 'close' }); };
  const onFileOpen = (path: string) => { void call({ op: 'open', path, projectId: document.projectId }); };
  const props = { file, isSidebar: true, isFullscreen: false, onClose, onToggleFullscreen: () => { void call({ op: 'expand' }); } };
  const kind = getPreviewKind(document.name);
  if (document.source) return <pre className="native-source">{document.content}</pre>;
  const key = document.path + ':' + revision;
  if (kind === 'image') return <CodeEditorImageView key={key} {...props}/>;
  if (kind === 'pdf') return <CodeEditorPdfView key={key} {...props}/>;
  if (kind === 'audio' || kind === 'video') return <CodeEditorMediaPreview key={key} {...props} projectId={document.projectId} kind={kind}
    labels={{loading:'Loading media…',error:'Could not load media',playbackError:'This codec is not supported on this device.',download:'Download',openInNewTab:'Open',fullscreen:'Expand',exitFullscreen:'Restore',close:'Close'}}/>;
  return <CodeEditorSurface key={key} content={document.content} onChange={() => {}} previewMode
    isMarkdownFile={['md','markdown'].includes(ext)} isPlantUmlFile={['puml','plantuml','iuml','wsd'].includes(ext)}
    isDbmlFile={ext === 'dbml'} isCsvFile={['csv','tsv'].includes(ext)} isHtmlFile={['html','htm'].includes(ext)}
    isCustomRenderFile={document.customRenderer === true || document.name.endsWith('.flow.json')} apiSpecKind={detectApiSpecKind(document.name, document.content)}
    isDarkMode={isDarkMode} fontSize={17} showLineNumbers extensions={[]} currentFilePath={document.path} fileName={document.name}
    projectId={document.projectId} onFileOpen={onFileOpen} readOnly nativePaneControls/>;
}

function Viewer() {
  const [document, setDocument] = useState<Document | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    window.mcOpen = value => { current = value; setDocument(value); };
    window.mcChanged = () => setRevision(v => v + 1);
    window.mcSuspend = () => { setDocument(null); current = null; };
    void call({ op: 'ready' });
  }, []);
  if (!document) return <div className="native-empty">Choose a file from the project tree or chat.</div>;
  const key = document.path + ':' + revision;
  return <PreviewErrorBoundary key={key} document={document}>
    <DocumentPreview document={document} revision={revision}/>
  </PreviewErrorBoundary>;
}
createRoot(document.getElementById('root')!).render(<NativeThemeProvider><NativePreviewEventsProvider><Viewer/></NativePreviewEventsProvider></NativeThemeProvider>);
