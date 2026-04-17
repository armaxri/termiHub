import { useCallback } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "@/store/appStore";
import {
  localMkdir,
  localDelete,
  localRename,
  localWriteFile,
  localCopyFile,
  vscodeOpenLocal,
  sftpDownload,
} from "@/services/api";
import { FileEntry } from "@/types/connection";

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
    // Windows drive root (e.g. "C:/" or "C:"): nothing above this
    if (/^[A-Za-z]:\/?$/.test(currentPath)) return;
    // Remove any trailing slash, then strip the last path segment
    const noTrailing = currentPath.endsWith("/") ? currentPath.slice(0, -1) : currentPath;
    const parts = noTrailing.split("/");
    parts.pop();
    let parentPath = parts.join("/") || "/";
    // A bare drive letter like "C:" becomes the drive root "C:/"
    if (/^[A-Za-z]:$/.test(parentPath)) {
      parentPath = parentPath + "/";
    }
    navigateTo(parentPath);
  }, [currentPath, navigateTo]);

  const refresh = useCallback(() => {
    refreshLocal();
  }, [refreshLocal]);

  const createDirectory = useCallback(
    async (name: string) => {
      const base = currentPath.endsWith("/") ? currentPath.slice(0, -1) : currentPath;
      const dirPath = base ? `${base}/${name}` : `/${name}`;
      await localMkdir(dirPath);
      refreshLocal();
    },
    [currentPath, refreshLocal]
  );

  const createFile = useCallback(
    async (name: string) => {
      const base = currentPath.endsWith("/") ? currentPath.slice(0, -1) : currentPath;
      const filePath = base ? `${base}/${name}` : `/${name}`;
      await localWriteFile(filePath, "");
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

  const uploadFileFromPath = useCallback(
    async (localPath: string) => {
      const parts = localPath.replace(/\\/g, "/").split("/");
      const fileName = parts[parts.length - 1] || "file";
      const base = currentPath.endsWith("/") ? currentPath.slice(0, -1) : currentPath;
      const destPath = base ? `${base}/${fileName}` : `/${fileName}`;
      if (localPath === destPath) return;
      await localCopyFile(localPath, destPath, false);
      refreshLocal();
    },
    [currentPath, refreshLocal]
  );

  const downloadFile = useCallback(async (filePath: string, fileName: string) => {
    const localPath = await save({ title: "Save file as...", defaultPath: fileName });
    if (!localPath) return;
    const isDir =
      useAppStore.getState().localFileEntries.find((e) => e.path === filePath)?.isDirectory ??
      false;
    await localCopyFile(filePath, localPath, isDir);
  }, []);

  const copyEntry = useCallback(
    (entries: FileEntry[]) => {
      useAppStore.getState().setFileClipboard({
        entries,
        operation: "copy",
        sourceMode: "local",
        sourcePath: currentPath,
        sftpSessionId: null,
      });
    },
    [currentPath]
  );

  const cutEntry = useCallback(
    (entries: FileEntry[]) => {
      useAppStore.getState().setFileClipboard({
        entries,
        operation: "cut",
        sourceMode: "local",
        sourcePath: currentPath,
        sftpSessionId: null,
      });
    },
    [currentPath]
  );

  const pasteEntry = useCallback(async () => {
    const clipboard = useAppStore.getState().fileClipboard;
    if (!clipboard) return;

    const destDir = currentPath;

    for (const clipEntry of clipboard.entries) {
      const destPath = destDir === "/" ? `/${clipEntry.name}` : `${destDir}/${clipEntry.name}`;

      if (clipboard.sourceMode === "local") {
        // local→local
        if (clipboard.operation === "cut") {
          await localRename(clipEntry.path, destPath);
        } else {
          await localCopyFile(clipEntry.path, destPath, clipEntry.isDirectory);
        }
      } else {
        // sftp→local: download remote file to local destination
        if (clipboard.sftpSessionId) {
          await sftpDownload(clipboard.sftpSessionId, clipEntry.path, destPath);
        }
      }
    }

    if (clipboard.operation === "cut") {
      useAppStore.getState().setFileClipboard(null);
    }

    refreshLocal();
  }, [currentPath, refreshLocal]);

  return {
    fileEntries,
    currentPath,
    isConnected: true,
    isLoading,
    error,
    navigateTo,
    navigateUp,
    refresh,
    downloadFile,
    uploadFile: async () => {
      /* no-op: files are already local */
    },
    uploadFileFromPath,
    createDirectory,
    createFile,
    deleteEntry,
    renameEntry,
    openInVscode,
    copyEntry,
    cutEntry,
    pasteEntry,
  };
}
