import { useCallback, useEffect, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "@/store/appStore";
import {
  sessionReadFile,
  sessionWriteFile,
  sessionDeleteFile,
  sessionRenameFile,
  sessionMkdir,
  sessionDownload,
  sessionUpload,
  sessionVscodeOpenRemote,
  sessionHasExecCapability,
} from "@/services/api";
import { FileEntry } from "@/types/connection";
import { frontendLog } from "@/utils/frontendLog";
import { runTransfer, seedTransferQueueRow } from "./transferFeedback";

/**
 * Hook for session-based file system operations.
 *
 * Backs every file-browser-capable connection type routed through the session
 * layer: remote-agent sessions, Docker, FTP, and — since the SFTP convergence
 * (#2421) — SSH. File ops flow through the active terminal session's file
 * browser capability (`session_*` commands) rather than a separate `SftpManager`
 * session.
 *
 * # SFTP-backed vs byte-based transfers (#2421)
 *
 * Two transport shapes back a session (mirroring the editor split in #2420):
 *
 * - An **SFTP-backed** session (SSH) resolves its ops via the backend's
 *   `SftpFileBrowser`, so it can drive the **dedicated per-transfer channel** —
 *   `session_download` / `session_upload` register a background transfer that
 *   keeps the listing live and feeds the Transfer Queue + progress events, and
 *   `session_vscode_open_remote` supports remote VS Code editing.
 * - A **byte-based** backend (Docker / FTP / remote-agent) has no SFTP channel,
 *   so transfers fall back to a blocking `session_read_file` / `session_write_file`
 *   round-trip and VS Code remote open is unavailable.
 *
 * The transport is detected with the same signal #2420 chose for the editor: the
 * `session_has_exec_capability` probe **resolves** (with the exec boolean) only
 * for an SFTP-backed session and **rejects** for a byte-based backend. A resolved
 * probe flips {@link sftpCapable} on, unlocking the dedicated channel + VS Code;
 * a rejection leaves the session on the byte-based path.
 */
export function useSessionFileSystem() {
  const sessionFileEntries = useAppStore((s) => s.sessionFileEntries);
  const sessionCurrentPath = useAppStore((s) => s.sessionCurrentPath);
  const sessionFileBrowserId = useAppStore((s) => s.sessionFileBrowserId);
  const sessionFileLoading = useAppStore((s) => s.sessionFileLoading);
  const sessionFileError = useAppStore((s) => s.sessionFileError);
  const navigateSession = useAppStore((s) => s.navigateSession);
  const refreshSession = useAppStore((s) => s.refreshSession);

  // Whether the current session's backend is SFTP-backed and can therefore drive
  // the dedicated transfer channel + VS Code remote open (#2421). Determined by
  // the `session_has_exec_capability` probe, which resolves only for an
  // SFTP-backed session and rejects for a byte-based backend (see the hook
  // doc-comment). `false` until the probe resolves, so a byte-based backend (and
  // the brief pre-probe window) uses the byte-based read/write fallback.
  const [sftpCapable, setSftpCapable] = useState(false);

  useEffect(() => {
    setSftpCapable(false);
    if (!sessionFileBrowserId) return;
    let cancelled = false;
    const sessionId = sessionFileBrowserId;
    sessionHasExecCapability(sessionId)
      .then(() => {
        if (cancelled) return;
        // Resolved → the session is SFTP-backed; enable the dedicated channel.
        setSftpCapable(true);
        frontendLog("session_file_browser", `session ${sessionId} is SFTP-backed`);
      })
      .catch((err) => {
        if (cancelled) return;
        // Rejected → byte-based backend; keep the read/write fallback.
        setSftpCapable(false);
        frontendLog(
          "session_file_browser",
          `session ${sessionId} is not SFTP-backed; byte-based transfers: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      });
    return () => {
      cancelled = true;
    };
  }, [sessionFileBrowserId]);

  // Dedicated-channel transfer wrappers that seed a Transfer Queue row from the
  // id the start command returns (#1632), mirroring the SFTP hook. Only used on
  // the SFTP-backed path; the byte-based fallback has no transfer id to seed.
  const startDownload = useCallback(
    (sessionId: string, remotePath: string, localPath: string) =>
      sessionDownload(sessionId, remotePath, localPath, (transferId) =>
        seedTransferQueueRow({ transferId, sessionId, direction: "download", remotePath })
      ),
    []
  );
  const startUpload = useCallback(
    (sessionId: string, localPath: string, remotePath: string) =>
      sessionUpload(sessionId, localPath, remotePath, (transferId) =>
        seedTransferQueueRow({ transferId, sessionId, direction: "upload", remotePath })
      ),
    []
  );

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
      if (sftpCapable) {
        // SFTP-backed: stream over the dedicated transfer channel (#2421).
        await runTransfer(
          "Download",
          () => startDownload(sessionFileBrowserId, remotePath, localPath),
          { loading: `Downloading ${fileName}…` }
        );
        return;
      }
      // Byte-based fallback (Docker / FTP / remote-agent): blocking round-trip.
      const data = await sessionReadFile(sessionFileBrowserId, remotePath);
      const { writeFile } = await import("@tauri-apps/plugin-fs");
      await writeFile(localPath, new Uint8Array(data));
    },
    [sessionFileBrowserId, sftpCapable, startDownload]
  );

  const uploadFile = useCallback(async () => {
    if (!sessionFileBrowserId) return;
    const { open } = await import("@tauri-apps/plugin-dialog");
    const localPath = await open({ title: "Select file to upload", multiple: false });
    if (!localPath) return;
    const fileName =
      (localPath as string).split("/").pop() ?? (localPath as string).split("\\").pop() ?? "upload";
    const remotePath =
      sessionCurrentPath === "/" ? `/${fileName}` : `${sessionCurrentPath}/${fileName}`;
    if (sftpCapable) {
      // SFTP-backed: stream over the dedicated transfer channel (#2421).
      const ok = await runTransfer(
        "Upload",
        () => startUpload(sessionFileBrowserId, localPath as string, remotePath),
        { loading: `Uploading ${fileName}…` }
      );
      if (ok) refreshSession();
      return;
    }
    // Byte-based fallback (Docker / FTP / remote-agent): blocking round-trip.
    const { readFile } = await import("@tauri-apps/plugin-fs");
    const data = await readFile(localPath as string);
    await sessionWriteFile(sessionFileBrowserId, remotePath, Array.from(data));
    refreshSession();
  }, [sessionFileBrowserId, sessionCurrentPath, refreshSession, sftpCapable, startUpload]);

  const uploadFileFromPath = useCallback(
    async (localPath: string) => {
      if (!sessionFileBrowserId) return;
      const parts = localPath.replace(/\\/g, "/").split("/");
      const fileName = parts[parts.length - 1] || "upload";
      const remotePath =
        sessionCurrentPath === "/" ? `/${fileName}` : `${sessionCurrentPath}/${fileName}`;
      if (sftpCapable) {
        // SFTP-backed: stream over the dedicated transfer channel (#2421).
        const ok = await runTransfer(
          "Upload",
          () => startUpload(sessionFileBrowserId, localPath, remotePath),
          { loading: `Uploading ${fileName}…` }
        );
        if (ok) refreshSession();
        return;
      }
      // Byte-based fallback (Docker / FTP / remote-agent): blocking round-trip.
      const { readFile } = await import("@tauri-apps/plugin-fs");
      const data = await readFile(localPath);
      await sessionWriteFile(sessionFileBrowserId, remotePath, Array.from(data));
      refreshSession();
    },
    [sessionFileBrowserId, sessionCurrentPath, refreshSession, sftpCapable, startUpload]
  );

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

  const openInVscode = useCallback(
    async (remotePath: string) => {
      // Only an SFTP-backed session can drive VS Code remote open (download →
      // edit → re-upload). A byte-based backend has no such channel (#2421).
      if (!sessionFileBrowserId || !sftpCapable) return;
      await sessionVscodeOpenRemote(sessionFileBrowserId, remotePath);
    },
    [sessionFileBrowserId, sftpCapable]
  );

  const copyEntry = useCallback(
    (entries: FileEntry[]) => {
      useAppStore.getState().setFileClipboard({
        entries,
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
    (entries: FileEntry[]) => {
      useAppStore.getState().setFileClipboard({
        entries,
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

    const pasteOne = async (clipEntry: FileEntry): Promise<void> => {
      const destPath = destDir === "/" ? `/${clipEntry.name}` : `${destDir}/${clipEntry.name}`;

      if (clipboard.sourceMode === "session") {
        // Cross-pane paste keys the source session on `terminalSessionId` (the
        // session id) — SSH now flows through here too since the convergence
        // (#2421), so the retired `sftpSessionId` clipboard field is unused.
        const srcId = clipboard.terminalSessionId;
        if (clipboard.operation === "cut" && srcId === sessionFileBrowserId) {
          await sessionRenameFile(sessionFileBrowserId, clipEntry.path, destPath);
        } else {
          // Cross-session or copy: read source, write to dest. No dedicated
          // session-to-session copy command exists, so this stays a byte-based
          // round-trip regardless of the SFTP capability.
          const srcSession = srcId ?? sessionFileBrowserId;
          const data = await sessionReadFile(srcSession, clipEntry.path);
          await sessionWriteFile(sessionFileBrowserId, destPath, data);
          if (clipboard.operation === "cut") {
            await sessionDeleteFile(srcSession, clipEntry.path);
          }
        }
      } else if (clipboard.sourceMode === "local") {
        // local→session: upload the local file to the remote destination.
        if (sftpCapable) {
          // SFTP-backed: stream over the dedicated transfer channel (#2421).
          await startUpload(sessionFileBrowserId, clipEntry.path, destPath);
        } else {
          // Byte-based fallback (Docker / FTP / remote-agent).
          const { readFile } = await import("@tauri-apps/plugin-fs");
          const data = await readFile(clipEntry.path);
          await sessionWriteFile(sessionFileBrowserId, destPath, Array.from(data));
        }
      }
      // sftp→session: not supported (no legacy SFTP source pane remains post-#2421)
    };

    for (const clipEntry of clipboard.entries) {
      const ok = await runTransfer("Paste", () => pasteOne(clipEntry), {
        loading: `Pasting ${clipEntry.name}…`,
      });
      // Abort on first failure so a cut clipboard is not cleared and the user is
      // not left with a partial, silently-incomplete paste.
      if (!ok) return;
    }

    if (clipboard.operation === "cut") {
      useAppStore.getState().setFileClipboard(null);
    }

    refreshSession();
  }, [sessionFileBrowserId, sessionCurrentPath, refreshSession, sftpCapable, startUpload]);

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
