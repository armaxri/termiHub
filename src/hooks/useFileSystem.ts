import { useCallback } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "@/store/appStore";
import {
  sftpDownload,
  sftpUpload,
  sftpMkdir,
  sftpDelete,
  sftpRename,
  vscodeOpenRemote,
} from "@/services/api";

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
    deleteEntry,
    renameEntry,
    openInVscode,
  };
}
