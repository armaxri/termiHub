import { useCallback } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "@/store/appStore";
import {
  sftpDownload,
  sftpUpload,
  sftpMkdir,
  sftpDelete,
  sftpRename,
  sftpWriteFileContent,
  vscodeOpenRemote,
} from "@/services/api";
import { FileEntry } from "@/types/connection";

/**
 * Hook for SFTP file system operations.
 */
export function useFileSystem() {
  const fileEntries = useAppStore((s) => s.fileEntries);
  const currentPath = useAppStore((s) => s.currentPath);
  const sftpSessionId = useAppStore((s) => s.sftpSessionId);
  const sftpLoading = useAppStore((s) => s.sftpLoading);
  const sftpError = useAppStore((s) => s.sftpError);
  const navigateSftp = useAppStore((s) => s.navigateSftp);
  const refreshSftp = useAppStore((s) => s.refreshSftp);

  const navigateTo = useCallback(
    (path: string) => {
      navigateSftp(path);
    },
    [navigateSftp]
  );

  const navigateUp = useCallback(() => {
    if (currentPath === "/") return;
    const parentPath = currentPath.split("/").slice(0, -1).join("/") || "/";
    navigateTo(parentPath);
  }, [currentPath, navigateTo]);

  const refresh = useCallback(() => {
    refreshSftp();
  }, [refreshSftp]);

  const downloadFile = useCallback(
    async (remotePath: string, fileName: string) => {
      if (!sftpSessionId) return;
      const localPath = await save({ title: "Save file as...", defaultPath: fileName });
      if (!localPath) return;
      await sftpDownload(sftpSessionId, remotePath, localPath);
    },
    [sftpSessionId]
  );

  const uploadFile = useCallback(async () => {
    if (!sftpSessionId) return;
    const localPath = await open({ title: "Select file to upload", multiple: false });
    if (!localPath) return;
    const fileName = localPath.split("/").pop() ?? localPath.split("\\").pop() ?? "upload";
    const remotePath = currentPath === "/" ? `/${fileName}` : `${currentPath}/${fileName}`;
    await sftpUpload(sftpSessionId, localPath, remotePath);
    refreshSftp();
  }, [sftpSessionId, currentPath, refreshSftp]);

  const createDirectory = useCallback(
    async (name: string) => {
      if (!sftpSessionId) return;
      const dirPath = currentPath === "/" ? `/${name}` : `${currentPath}/${name}`;
      await sftpMkdir(sftpSessionId, dirPath);
      refreshSftp();
    },
    [sftpSessionId, currentPath, refreshSftp]
  );

  const createFile = useCallback(
    async (name: string) => {
      if (!sftpSessionId) return;
      const filePath = currentPath === "/" ? `/${name}` : `${currentPath}/${name}`;
      await sftpWriteFileContent(sftpSessionId, filePath, "");
      refreshSftp();
    },
    [sftpSessionId, currentPath, refreshSftp]
  );

  const deleteEntry = useCallback(
    async (path: string, isDirectory: boolean) => {
      if (!sftpSessionId) return;
      await sftpDelete(sftpSessionId, path, isDirectory);
      refreshSftp();
    },
    [sftpSessionId, refreshSftp]
  );

  const renameEntry = useCallback(
    async (oldPath: string, newName: string) => {
      if (!sftpSessionId) return;
      const parentDir = oldPath.split("/").slice(0, -1).join("/") || "/";
      const newPath = parentDir === "/" ? `/${newName}` : `${parentDir}/${newName}`;
      await sftpRename(sftpSessionId, oldPath, newPath);
      refreshSftp();
    },
    [sftpSessionId, refreshSftp]
  );

  const openInVscode = useCallback(
    async (remotePath: string) => {
      if (!sftpSessionId) return;
      await vscodeOpenRemote(sftpSessionId, remotePath);
    },
    [sftpSessionId]
  );

  const copyEntry = useCallback(
    (entries: FileEntry[]) => {
      useAppStore.getState().setFileClipboard({
        entries,
        operation: "copy",
        sourceMode: "sftp",
        sourcePath: currentPath,
        sftpSessionId,
      });
    },
    [currentPath, sftpSessionId]
  );

  const cutEntry = useCallback(
    (entries: FileEntry[]) => {
      useAppStore.getState().setFileClipboard({
        entries,
        operation: "cut",
        sourceMode: "sftp",
        sourcePath: currentPath,
        sftpSessionId,
      });
    },
    [currentPath, sftpSessionId]
  );

  const pasteEntry = useCallback(async () => {
    const clipboard = useAppStore.getState().fileClipboard;
    if (!clipboard || !sftpSessionId) return;

    const destDir = currentPath;

    for (const clipEntry of clipboard.entries) {
      const destPath = destDir === "/" ? `/${clipEntry.name}` : `${destDir}/${clipEntry.name}`;

      if (clipboard.sourceMode === "sftp") {
        // sftp→sftp
        if (clipboard.operation === "cut") {
          if (clipboard.sftpSessionId === sftpSessionId) {
            await sftpRename(sftpSessionId, clipEntry.path, destPath);
          } else {
            // Different SFTP session — download to temp then upload
            const tempPath = `/tmp/termihub-paste-${Date.now()}-${clipEntry.name}`;
            await sftpDownload(clipboard.sftpSessionId!, clipEntry.path, tempPath);
            await sftpUpload(sftpSessionId, tempPath, destPath);
          }
        } else {
          // Copy within SFTP: download to temp, re-upload
          const tempPath = `/tmp/termihub-paste-${Date.now()}-${clipEntry.name}`;
          if (clipboard.sftpSessionId) {
            await sftpDownload(clipboard.sftpSessionId, clipEntry.path, tempPath);
            await sftpUpload(sftpSessionId, tempPath, destPath);
          }
        }
      } else {
        // local→sftp: upload local file to remote destination
        await sftpUpload(sftpSessionId, clipEntry.path, destPath);
      }
    }

    if (clipboard.operation === "cut") {
      useAppStore.getState().setFileClipboard(null);
    }

    refreshSftp();
  }, [sftpSessionId, currentPath, refreshSftp]);

  return {
    fileEntries,
    currentPath,
    isConnected: sftpSessionId !== null,
    isLoading: sftpLoading,
    error: sftpError,
    navigateTo,
    navigateUp,
    refresh,
    downloadFile,
    uploadFile,
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
