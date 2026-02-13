import { useCallback } from "react";
import { useAppStore } from "@/store/appStore";
import {
  localMkdir,
  localDelete,
  localRename,
  vscodeOpenLocal,
} from "@/services/api";

/**
 * Hook for local filesystem operations.
 * Same shape as useFileSystem for SFTP.
 */
export function useLocalFileSystem() {
  const fileEntries = useAppStore((s) => s.localFileEntries);
  const currentPath = useAppStore((s) => s.localCurrentPath);
  const isLoading = useAppStore((s) => s.localFileLoading);
  const error = useAppStore((s) => s.localFileError);
  const navigateLocal = useAppStore((s) => s.navigateLocal);
  const refreshLocal = useAppStore((s) => s.refreshLocal);

  const navigateTo = useCallback(
    (path: string) => {
      navigateLocal(path);
    },
    [navigateLocal]
  );

  const navigateUp = useCallback(() => {
    if (currentPath === "/") return;
    const parentPath = currentPath.split("/").slice(0, -1).join("/") || "/";
    navigateTo(parentPath);
  }, [currentPath, navigateTo]);

  const refresh = useCallback(() => {
    refreshLocal();
  }, [refreshLocal]);

  const createDirectory = useCallback(
    async (name: string) => {
      const dirPath = currentPath === "/" ? `/${name}` : `${currentPath}/${name}`;
      await localMkdir(dirPath);
      refreshLocal();
    },
    [currentPath, refreshLocal]
  );

  const deleteEntry = useCallback(
    async (path: string, isDirectory: boolean) => {
      await localDelete(path, isDirectory);
      refreshLocal();
    },
    [refreshLocal]
  );

  const renameEntry = useCallback(
    async (oldPath: string, newName: string) => {
      const parentDir = oldPath.split("/").slice(0, -1).join("/") || "/";
      const newPath = parentDir === "/" ? `/${newName}` : `${parentDir}/${newName}`;
      await localRename(oldPath, newPath);
      refreshLocal();
    },
    [refreshLocal]
  );

  const openInVscode = useCallback(async (path: string) => {
    await vscodeOpenLocal(path);
  }, []);

  return {
    fileEntries,
    currentPath,
    isConnected: true,
    isLoading,
    error,
    navigateTo,
    navigateUp,
    refresh,
    downloadFile: async () => { /* no-op: files are already local */ },
    uploadFile: async () => { /* no-op: files are already local */ },
    createDirectory,
    deleteEntry,
    renameEntry,
    openInVscode,
  };
}
