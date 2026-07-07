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
import { toast } from "@/components/ui";
import { frontendLog } from "@/utils/frontendLog";

/** Extract a human-readable message from an unknown transfer error. */
function transferErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

/**
 * Run an SFTP transfer with user feedback: a pending toast that resolves in
 * place into success or a persistent error (audit gap D2 — transfers must
 * never fail silently). The rejection is surfaced via `toast.error` and logged
 * to the LogViewer, then swallowed so callers do not produce an unhandled
 * rejection. Returns whether the transfer succeeded.
 */
async function runTransfer(
  label: string,
  action: () => Promise<unknown>,
  messages: { loading: string; success: string }
): Promise<boolean> {
  const toastId = toast.loading(messages.loading);
  try {
    await action();
    toast.success(messages.success, { id: toastId });
    return true;
  } catch (error) {
    const message = transferErrorMessage(error);
    frontendLog("sftp_transfer", `${label} failed: ${message}`);
    toast.error(`${label} failed: ${message}`, { id: toastId });
    return false;
  }
}

/**
 * Hook for SFTP file system operations.
 */
export function useFileSystem() {
  const fileEntries = useAppStore((s) => s.fileEntries);
  const currentPath = useAppStore((s) => s.currentPath);
  const sftpSessionId = useAppStore((s) => s.sftpSessionId);
  const sftpStatus = useAppStore((s) => s.sftpStatus);
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
      await runTransfer("Download", () => sftpDownload(sftpSessionId, remotePath, localPath), {
        loading: `Downloading ${fileName}…`,
        success: `Downloaded ${fileName}`,
      });
    },
    [sftpSessionId]
  );

  const uploadFile = useCallback(async () => {
    if (!sftpSessionId) return;
    const localPath = await open({ title: "Select file to upload", multiple: false });
    if (!localPath) return;
    const fileName = localPath.split("/").pop() ?? localPath.split("\\").pop() ?? "upload";
    const remotePath = currentPath === "/" ? `/${fileName}` : `${currentPath}/${fileName}`;
    const ok = await runTransfer("Upload", () => sftpUpload(sftpSessionId, localPath, remotePath), {
      loading: `Uploading ${fileName}…`,
      success: `Uploaded ${fileName}`,
    });
    if (ok) refreshSftp();
  }, [sftpSessionId, currentPath, refreshSftp]);

  const uploadFileFromPath = useCallback(
    async (localPath: string) => {
      if (!sftpSessionId) return;
      const parts = localPath.replace(/\\/g, "/").split("/");
      const fileName = parts[parts.length - 1] || "upload";
      const remotePath = currentPath === "/" ? `/${fileName}` : `${currentPath}/${fileName}`;
      const ok = await runTransfer(
        "Upload",
        () => sftpUpload(sftpSessionId, localPath, remotePath),
        { loading: `Uploading ${fileName}…`, success: `Uploaded ${fileName}` }
      );
      if (ok) refreshSftp();
    },
    [sftpSessionId, currentPath, refreshSftp]
  );

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

    const pasteOne = async (clipEntry: FileEntry): Promise<void> => {
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
    };

    for (const clipEntry of clipboard.entries) {
      const ok = await runTransfer("Paste", () => pasteOne(clipEntry), {
        loading: `Pasting ${clipEntry.name}…`,
        success: `Pasted ${clipEntry.name}`,
      });
      // Abort on first failure so a cut clipboard is not cleared and the user
      // is not left with a partial, silently-incomplete paste.
      if (!ok) return;
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
    // Derived from the explicit status enum (audit gap A1): either the initial
    // connect or a directory list is in flight. Callers that need to tell
    // "connecting" apart from "listing" read `sftpStatus` from the store.
    isLoading: sftpStatus === "connecting" || sftpStatus === "listing",
    error: sftpError,
    navigateTo,
    navigateUp,
    refresh,
    downloadFile,
    uploadFile,
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
