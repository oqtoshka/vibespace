import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../../utils/api';
import { useProjectFilesWatch, type FileChange } from '../../../hooks/useProjectFilesWatch';
import type { CodeEditorFile } from '../types/types';
import { isBinaryFile } from '../utils/binaryFile';

type UseCodeEditorDocumentParams = {
  file: CodeEditorFile;
  projectPath?: string;
};

const getErrorMessage = (error: unknown) => {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
};

export const useCodeEditorDocument = ({ file, projectPath }: UseCodeEditorDocumentParams) => {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isBinary, setIsBinary] = useState(false);
  // The content as it currently sits on disk (what we last loaded or saved).
  // Used to detect unsaved local edits so a disk-change reload never clobbers
  // them, and to skip no-op reloads triggered by our own saves.
  const diskContentRef = useRef('');
  const savingRef = useRef(false);
  // `fileProjectId` is the DB primary key passed down from the editor sidebar;
  // the fallback to `projectPath` preserves older callers that didn't yet
  // propagate the identifier.
  const fileProjectId = file.projectId ?? projectPath;
  const filePath = file.path;
  const fileName = file.name;
  const fileDiffNewString = file.diffInfo?.new_string;
  const fileDiffOldString = file.diffInfo?.old_string;
  const hasDiff = Boolean(file.diffInfo);

  const loadFileContent = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      try {
        if (!silent) {
          setLoading(true);
        }
        setIsBinary(false);

        // Check if file is binary by extension
        if (isBinaryFile(fileName)) {
          setIsBinary(true);
          if (!silent) {
            setLoading(false);
          }
          return;
        }

        // Diff payload may already include full old/new snapshots, so avoid disk read.
        if (hasDiff && fileDiffNewString !== undefined && fileDiffOldString !== undefined) {
          setContent(fileDiffNewString);
          diskContentRef.current = fileDiffNewString;
          if (!silent) {
            setLoading(false);
          }
          return;
        }

        if (!fileProjectId) {
          throw new Error('Missing project identifier');
        }

        const response = await api.readFile(fileProjectId, filePath);
        if (!response.ok) {
          throw new Error(`Failed to load file: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        setContent(data.content);
        diskContentRef.current = data.content;
      } catch (error) {
        const message = getErrorMessage(error);
        console.error('Error loading file:', error);
        // A silent (watch-triggered) reload that fails must not trash the
        // buffer the user is looking at — only the initial load surfaces it.
        if (!silent) {
          setContent(`// Error loading file: ${message}\n// File: ${fileName}\n// Path: ${filePath}`);
        }
      } finally {
        if (!silent) {
          setLoading(false);
        }
      }
    },
    [fileDiffNewString, fileDiffOldString, fileName, filePath, fileProjectId, hasDiff],
  );

  useEffect(() => {
    void loadFileContent();
  }, [loadFileContent]);

  // Live-reload when the open file changes on disk (e.g. an agent edits it),
  // unless the user has unsaved edits or a save is in flight.
  const handleExternalChange = useCallback(
    (changes: FileChange[]) => {
      if (isBinary || hasDiff || savingRef.current) {
        return;
      }
      const touched = changes.some(
        (change) => change.path === filePath && (change.type === 'change' || change.type === 'add'),
      );
      if (!touched) {
        return;
      }
      // Unsaved local edits diverge from disk — leave the buffer alone.
      if (content !== diskContentRef.current) {
        return;
      }
      void loadFileContent({ silent: true });
    },
    [content, filePath, hasDiff, isBinary, loadFileContent],
  );
  useProjectFilesWatch(fileProjectId, handleExternalChange);

  const handleSave = useCallback(async () => {
    setSaving(true);
    savingRef.current = true;
    setSaveError(null);

    try {
      if (!fileProjectId) {
        throw new Error('Missing project identifier');
      }

      const response = await api.saveFile(fileProjectId, filePath, content);

      if (!response.ok) {
        const contentType = response.headers.get('content-type');
        if (contentType?.includes('application/json')) {
          const errorData = await response.json();
          throw new Error(errorData.error || `Save failed: ${response.status}`);
        }

        const textError = await response.text();
        console.error('Non-JSON error response:', textError);
        throw new Error(`Save failed: ${response.status} ${response.statusText}`);
      }

      await response.json();

      // The buffer now matches disk; remember it so the watcher's echo of our
      // own write isn't mistaken for an external change.
      diskContentRef.current = content;
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2000);
    } catch (error) {
      const message = getErrorMessage(error);
      console.error('Error saving file:', error);
      setSaveError(message);
    } finally {
      setSaving(false);
      savingRef.current = false;
    }
  }, [content, filePath, fileProjectId]);

  const handleDownload = useCallback(() => {
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');

    anchor.href = url;
    anchor.download = file.name;

    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);

    URL.revokeObjectURL(url);
  }, [content, file.name]);

  return {
    content,
    setContent,
    loading,
    saving,
    saveSuccess,
    saveError,
    isBinary,
    handleSave,
    handleDownload,
  };
};
