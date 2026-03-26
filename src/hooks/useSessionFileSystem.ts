import { useCallback } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "@/store/appStore";
import {
  sessionReadFile,
  sessionWriteFile,
  sessionDeleteFile,
  sessionRenameFile,
  sessionMkdir,
} from "@/services/api";
import { FileEntry } from "@/types/connection";

/**
 * Hook for session-based file system operations.
 *
 * Used for remote-agent connections where file browsing is performed
 * through the active terminal session's file browser capability rather
 * than a separate SFTP session.
 */
export function useSessionFileSystem() {
  const sessionFileEntries = useAppStore((s) => s.sessionFileEntries);
  const sessionCurrentPath = useAppStore((s) => s.sessionCurrentPath);
  const sessionFileBrowserId = useAppStore((s) => s.sessionFileBrowserId);
  const sessionFileLoading = useAppStore((s) => s.sessionFileLoading);
  const sessionFileError = useAppStore((s) => s.sessionFileError);
  const navigateSession = useAppStore((s) => s.navigateSession);
  const refreshSession = useAppStore((s) => s.refreshSession);

  const navigateTo = useCallback(
    (path: string) => {
      if (!sessionFileBrowserId) return;
      navigateSession(sessionFileBrowserId, path);
    },
    [sessionFileBrowserId, navigateSession]
  );

  const navigateUp = useCallback(() => {
    if (sessionCurrentPath === "/") return;
    const parentPath = sessionCurrentPath.split("/").slice(0, -1).join("/") || "/";
    navigateTo(parentPath);
  }, [sessionCurrentPath, navigateTo]);

  const refresh = useCallback(() => {
    refreshSession();
  }, [refreshSession]);

  const downloadFile = useCallback(
    async (remotePath: string, fileName: string) => {
      if (!sessionFileBrowserId) return;
      const localPath = await save({ title: "Save file as...", defaultPath: fileName });
      if (!localPath) return;
      const data = await sessionReadFile(sessionFileBrowserId, remotePath);
      const { writeFile } = await import("@tauri-apps/plugin-fs");
      await writeFile(localPath, new Uint8Array(data));
    },
    [sessionFileBrowserId]
  );

  const uploadFile = useCallback(async () => {
    if (!sessionFileBrowserId) return;
    const { open } = await import("@tauri-apps/plugin-dialog");
    const localPath = await open({ title: "Select file to upload", multiple: false });
    if (!localPath) return;
    const { readFile } = await import("@tauri-apps/plugin-fs");
    const data = await readFile(localPath);
    const fileName =
      (localPath as string).split("/").pop() ?? (localPath as string).split("\\").pop() ?? "upload";
    const remotePath =
      sessionCurrentPath === "/" ? `/${fileName}` : `${sessionCurrentPath}/${fileName}`;
    await sessionWriteFile(sessionFileBrowserId, remotePath, Array.from(data));
    refreshSession();
  }, [sessionFileBrowserId, sessionCurrentPath, refreshSession]);

  const createDirectory = useCallback(
    async (name: string) => {
      if (!sessionFileBrowserId) return;
      const dirPath = sessionCurrentPath === "/" ? `/${name}` : `${sessionCurrentPath}/${name}`;
      await sessionMkdir(sessionFileBrowserId, dirPath);
      refreshSession();
    },
    [sessionFileBrowserId, sessionCurrentPath, refreshSession]
  );

  const createFile = useCallback(
    async (name: string) => {
      if (!sessionFileBrowserId) return;
      const filePath = sessionCurrentPath === "/" ? `/${name}` : `${sessionCurrentPath}/${name}`;
      await sessionWriteFile(sessionFileBrowserId, filePath, []);
      refreshSession();
    },
    [sessionFileBrowserId, sessionCurrentPath, refreshSession]
  );

  const deleteEntry = useCallback(
    async (path: string, _isDirectory: boolean) => {
      if (!sessionFileBrowserId) return;
      await sessionDeleteFile(sessionFileBrowserId, path);
      refreshSession();
    },
    [sessionFileBrowserId, refreshSession]
  );

  const renameEntry = useCallback(
    async (oldPath: string, newName: string) => {
      if (!sessionFileBrowserId) return;
      const parentDir = oldPath.split("/").slice(0, -1).join("/") || "/";
      const newPath = parentDir === "/" ? `/${newName}` : `${parentDir}/${newName}`;
      await sessionRenameFile(sessionFileBrowserId, oldPath, newPath);
      refreshSession();
    },
    [sessionFileBrowserId, refreshSession]
  );

  const openInVscode = useCallback(async (_remotePath: string) => {
    // VS Code remote open is not supported for session-based connections.
  }, []);

  const copyEntry = useCallback(
    (entry: FileEntry) => {
      useAppStore.getState().setFileClipboard({
        entry,
        operation: "copy",
        sourceMode: "session",
        sourcePath: sessionCurrentPath,
        sftpSessionId: null,
        terminalSessionId: sessionFileBrowserId,
      });
    },
    [sessionCurrentPath, sessionFileBrowserId]
  );

  const cutEntry = useCallback(
    (entry: FileEntry) => {
      useAppStore.getState().setFileClipboard({
        entry,
        operation: "cut",
        sourceMode: "session",
        sourcePath: sessionCurrentPath,
        sftpSessionId: null,
        terminalSessionId: sessionFileBrowserId,
      });
    },
    [sessionCurrentPath, sessionFileBrowserId]
  );

  const pasteEntry = useCallback(async () => {
    const clipboard = useAppStore.getState().fileClipboard;
    if (!clipboard || !sessionFileBrowserId) return;

    const destDir = sessionCurrentPath;
    const destPath =
      destDir === "/" ? `/${clipboard.entry.name}` : `${destDir}/${clipboard.entry.name}`;

    if (clipboard.sourceMode === "session") {
      const srcId = clipboard.terminalSessionId;
      if (clipboard.operation === "cut" && srcId === sessionFileBrowserId) {
        await sessionRenameFile(sessionFileBrowserId, clipboard.entry.path, destPath);
        useAppStore.getState().setFileClipboard(null);
      } else {
        // Cross-session or copy: read source, write to dest
        const srcSession = srcId ?? sessionFileBrowserId;
        const data = await sessionReadFile(srcSession, clipboard.entry.path);
        await sessionWriteFile(sessionFileBrowserId, destPath, data);
        if (clipboard.operation === "cut") {
          await sessionDeleteFile(srcSession, clipboard.entry.path);
          useAppStore.getState().setFileClipboard(null);
        }
      }
    } else if (clipboard.sourceMode === "local") {
      // local→session: read local file and write to session
      const { readFile } = await import("@tauri-apps/plugin-fs");
      const data = await readFile(clipboard.entry.path);
      await sessionWriteFile(sessionFileBrowserId, destPath, Array.from(data));
      if (clipboard.operation === "cut") {
        useAppStore.getState().setFileClipboard(null);
      }
    }
    // sftp→session: not yet supported

    refreshSession();
  }, [sessionFileBrowserId, sessionCurrentPath, refreshSession]);

  return {
    fileEntries: sessionFileEntries,
    currentPath: sessionCurrentPath,
    isConnected: sessionFileBrowserId !== null,
    isLoading: sessionFileLoading,
    error: sessionFileError,
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
