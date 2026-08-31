import { useCallback, useRef } from 'react';

import { api } from '../utils/api';
import {
  resolveFileTreeReference,
  type FlatFileTreeEntry,
} from '../utils/fileTreeReference';
import type { Project } from '../types/app';

type FileNode = {
  type: 'file' | 'directory';
  name: string;
  path: string;
  children?: FileNode[];
};

// `diffInfo` is intentionally `any` so this resolver can wrap editor handlers
// that expect a concrete diff payload type as well as generic callers.
type OnFileOpen = (filePath: string, diffInfo?: any) => void;

const normalize = (value: string): string => value.replace(/\\/g, '/');

const flatten = (nodes: FileNode[], out: FlatFileTreeEntry[]): void => {
  for (const node of nodes) {
    out.push({ name: node.name, path: node.path, type: node.type });
    if (node.type === 'directory' && node.children && node.children.length > 0) {
      flatten(node.children, out);
    }
  }
};

/**
 * Wraps an `onFileOpen` handler so a possibly bare/partial file reference is
 * resolved against the project's file tree (cached per project) before the file
 * is opened in the in-app editor.
 */
export function useFileOpenResolver(
  selectedProject: Project | null | undefined,
  onFileOpen: OnFileOpen,
): OnFileOpen {
  const projectId = selectedProject?.projectId;
  const cacheRef = useRef<{ projectId?: string; files: Promise<FlatFileTreeEntry[]> | null }>({
    projectId: undefined,
    files: null,
  });

  const loadFiles = useCallback((): Promise<FlatFileTreeEntry[]> => {
    if (!projectId) {
      return Promise.resolve([]);
    }
    if (cacheRef.current.projectId === projectId && cacheRef.current.files) {
      return cacheRef.current.files;
    }

    const filesPromise = (async () => {
      try {
        const response = await api.getFiles(projectId);
        if (!response.ok) {
          return [];
        }
        const data = await response.json();
        const tree: FileNode[] = Array.isArray(data) ? data : [];
        const flat: FlatFileTreeEntry[] = [];
        flatten(tree, flat);
        return flat;
      } catch {
        return [];
      }
    })();

    cacheRef.current = { projectId, files: filesPromise };
    return filesPromise;
  }, [projectId]);

  return useCallback(
    (filePath: string, diffInfo?: any) => {
      const ref = normalize(filePath).trim();
      void loadFiles().then((files) => {
        const match = resolveFileTreeReference(files, ref);
        // A directory can be a valid path reference in chat, but it is not an
        // editor document. Silently leave it as navigation text instead of
        // creating a tab whose read request will fail with EISDIR.
        if (match?.type === 'directory') {
          return;
        }
        onFileOpen(match?.path ?? filePath, diffInfo);
      });
    },
    [loadFiles, onFileOpen],
  );
}
