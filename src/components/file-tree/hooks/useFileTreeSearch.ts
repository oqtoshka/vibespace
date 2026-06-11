import { useEffect, useState } from 'react';
import { collectExpandedDirectoryPaths, filterFileTree } from '../utils/fileTreeUtils';
import type { FileTreeNode } from '../types/types';

type UseFileTreeSearchArgs = {
  files: FileTreeNode[];
  expandDirectories: (paths: string[]) => void;
  // The tree loads lazily; searching needs the whole thing, so the first
  // query triggers a one-off deep fetch (results refine as it lands).
  ensureFullTree: () => void;
};

type UseFileTreeSearchResult = {
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  filteredFiles: FileTreeNode[];
};

export function useFileTreeSearch({
  files,
  expandDirectories,
  ensureFullTree,
}: UseFileTreeSearchArgs): UseFileTreeSearchResult {
  const [searchQuery, setSearchQuery] = useState('');
  const [filteredFiles, setFilteredFiles] = useState<FileTreeNode[]>(files);

  useEffect(() => {
    const query = searchQuery.trim().toLowerCase();

    if (!query) {
      setFilteredFiles(files);
      return;
    }

    ensureFullTree();
    const filtered = filterFileTree(files, query);
    setFilteredFiles(filtered);
    // Keep search results visible by opening every matching ancestor directory once per query update.
    expandDirectories(collectExpandedDirectoryPaths(filtered));
  }, [files, searchQuery, expandDirectories, ensureFullTree]);

  return {
    searchQuery,
    setSearchQuery,
    filteredFiles,
  };
}
