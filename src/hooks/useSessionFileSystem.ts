import { useCallback, useEffect, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "@/store/appStore";
import { currentFileBrowsersView } from "@/store/fileBrowsersBridge";
import { useProjectedFileBrowsers } from "@/store/useProjectedFileBrowsers";
import {
  sessionReadFile,
  sessionWriteFile,
  sessionDeleteFile,
  sessionRenameFile,
  sessionMkdir,
  sessionSetPermissions,
  sessionSetOwner,
  sessionCreateSymlink,
  sessionDownload,
  sessionUpload,
  sessionCopyRemote,
  sessionVscodeOpenRemote,
  sessionHasExecCapability,
} from "@/services/api";
import { FileEntry } from "@/types/connection";
import { frontendLog } from "@/utils/frontendLog";
import {
  runBlockingTransfer,
  runMaybeTrackedTransfer,
  runTransfer,
  seedTransferQueueRow,
} from "./transferFeedback";
import { errorMessage } from "@/utils/errorMessage";

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
  // The session pane's view (listing, cwd, loading, error) is sourced from the
  // authoritative `file-browser` projection region (#2283); the live session id
  // (`sessionFileBrowserId`) is the backend session model and stays an `appStore`
  // read (it gates `isConnected` and targets the session file ops).
  const sessionPane = useProjectedFileBrowsers().session;
  const sessionFileEntries = sessionPane.entries;
  const sessionCurrentPath = sessionPane.path;
  const sessionFileLoading = sessionPane.loading;
  const sessionFileError = sessionPane.error;
  const sessionFileBrowserId = useAppStore((s) => s.sessionFileBrowserId);
  const navigateSession = useAppStore((s) => s.navigateSession);
  const refreshSession = useAppStore((s) => s.refreshSession);
  const clearFileBrowserError = useAppStore((s) => s.clearFileBrowserError);

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
          `session ${sessionId} is not SFTP-backed; byte-based transfers: ${errorMessage(err)}`
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
  // Direct remote→remote copy: streams source→destination through the desktop as
  // ONE tracked transfer, seeding a single Transfer Queue row keyed on the
  // destination (where the file lands) — no local temp file (PROD-0013).
  const startRemoteCopy = useCallback(
    (srcSession: string, srcPath: string, dstSession: string, dstPath: string) =>
      sessionCopyRemote(srcSession, srcPath, dstSession, dstPath, (transferId) =>
        seedTransferQueueRow({
          transferId,
          sessionId: dstSession,
          direction: "upload",
          remotePath: dstPath,
        })
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

  // Return the promise so a Retry Button can drive its async pending state.
  const refresh = useCallback(() => refreshSession(), [refreshSession]);

  const dismissError = useCallback(() => clearFileBrowserError("session"), [clearFileBrowserError]);

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
      // Byte-based fallback (Docker / FTP / remote-agent): blocking round-trip
      // with no transfer-progress event, so surface its own feedback (UX-017)
      // rather than resolving silently.
      await runBlockingTransfer(
        async () => {
          const data = await sessionReadFile(sessionFileBrowserId, remotePath);
          const { writeFile } = await import("@tauri-apps/plugin-fs");
          await writeFile(localPath, data);
        },
        {
          loading: `Downloading ${fileName}…`,
          success: `Downloaded ${fileName}`,
          errorLabel: `Download "${fileName}"`,
        }
      );
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
    // Byte-based fallback (Docker / FTP / remote-agent): blocking round-trip
    // with no transfer-progress event, so surface its own feedback (#2906)
    // rather than resolving silently.
    const ok = await runBlockingTransfer(
      async () => {
        const { readFile } = await import("@tauri-apps/plugin-fs");
        const data = await readFile(localPath as string);
        await sessionWriteFile(sessionFileBrowserId, remotePath, data);
      },
      {
        loading: `Uploading ${fileName}…`,
        success: `Uploaded ${fileName}`,
        errorLabel: `Upload "${fileName}"`,
      }
    );
    if (ok) refreshSession();
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
      // Byte-based fallback (Docker / FTP / remote-agent): blocking round-trip
      // with no transfer-progress event, so surface its own feedback (#2906)
      // rather than resolving silently.
      const ok = await runBlockingTransfer(
        async () => {
          const { readFile } = await import("@tauri-apps/plugin-fs");
          const data = await readFile(localPath);
          await sessionWriteFile(sessionFileBrowserId, remotePath, data);
        },
        {
          loading: `Uploading ${fileName}…`,
          success: `Uploaded ${fileName}`,
          errorLabel: `Upload "${fileName}"`,
        }
      );
      if (ok) refreshSession();
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

  const setPermissions = useCallback(
    async (path: string, mode: number) => {
      if (!sessionFileBrowserId) return;
      await sessionSetPermissions(sessionFileBrowserId, path, mode);
      refreshSession();
    },
    [sessionFileBrowserId, refreshSession]
  );

  const setOwner = useCallback(
    async (path: string, uid: number | null, gid: number | null) => {
      if (!sessionFileBrowserId) return;
      await sessionSetOwner(sessionFileBrowserId, path, uid, gid);
      refreshSession();
    },
    [sessionFileBrowserId, refreshSession]
  );

  const createSymlink = useCallback(
    async (target: string, linkName: string) => {
      if (!sessionFileBrowserId) return;
      const linkPath =
        sessionCurrentPath === "/" ? `/${linkName}` : `${sessionCurrentPath}/${linkName}`;
      await sessionCreateSymlink(sessionFileBrowserId, target, linkPath);
      refreshSession();
    },
    [sessionFileBrowserId, sessionCurrentPath, refreshSession]
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
        terminalSessionId: sessionFileBrowserId,
      });
    },
    [sessionCurrentPath, sessionFileBrowserId]
  );

  const pasteEntry = useCallback(async () => {
    const clipboard = currentFileBrowsersView().clipboard;
    if (!clipboard || !sessionFileBrowserId) return;

    const destDir = sessionCurrentPath;

    // Resolves to whether the leg drove the dedicated (event-emitting) transfer
    // channel — `true` lets the caller defer the success toast to the event path,
    // `false` marks a byte-based round-trip that owns its own toast (#2906).
    const pasteOne = async (clipEntry: FileEntry): Promise<boolean> => {
      const destPath = destDir === "/" ? `/${clipEntry.name}` : `${destDir}/${clipEntry.name}`;

      if (clipboard.sourceMode === "session") {
        // Cross-pane paste keys the source session on `terminalSessionId` (the
        // session id) — SSH now flows through here too since the convergence
        // (#2421), so the retired `sftpSessionId` clipboard field is unused.
        const srcId = clipboard.terminalSessionId;
        if (clipboard.operation === "cut" && srcId === sessionFileBrowserId) {
          // Same-session move: a metadata rename with no transfer-progress event.
          await sessionRenameFile(sessionFileBrowserId, clipEntry.path, destPath);
          return false;
        } else {
          // Cross-session or copy. When BOTH endpoints are SFTP-backed, stream
          // the copy directly source→destination through the desktop as ONE
          // tracked transfer — no local temp file (PROD-0013). This replaces the
          // pre-#2421 download-to-temp + upload dance (two rows + a local disk
          // round-trip). The single row's name and remote path come from the
          // destination remote path (#1531/#1573); the backend derives
          // `file_name` from it. A byte-based endpoint (Docker/FTP/agent) has no
          // SFTP channel, so it keeps the read/write fallback below.
          const srcSession = srcId ?? sessionFileBrowserId;
          const srcSftp =
            srcSession === sessionFileBrowserId
              ? sftpCapable
              : await sessionHasExecCapability(srcSession)
                  .then(() => true)
                  .catch(() => false);
          let tracked: boolean;
          if (sftpCapable && srcSftp) {
            await startRemoteCopy(srcSession, clipEntry.path, sessionFileBrowserId, destPath);
            tracked = true;
          } else {
            // Byte-based fallback (Docker / FTP / remote-agent, or a mixed
            // transport where an endpoint has no SFTP channel): blocking
            // read/write round-trip, which registers no tracked transfer.
            const data = await sessionReadFile(srcSession, clipEntry.path);
            await sessionWriteFile(sessionFileBrowserId, destPath, data);
            tracked = false;
          }
          if (clipboard.operation === "cut") {
            await sessionDeleteFile(srcSession, clipEntry.path);
          }
          return tracked;
        }
      } else if (clipboard.sourceMode === "local") {
        // local→session: upload the local file to the remote destination.
        if (sftpCapable) {
          // SFTP-backed: stream over the dedicated transfer channel (#2421).
          await startUpload(sessionFileBrowserId, clipEntry.path, destPath);
          return true;
        }
        // Byte-based fallback (Docker / FTP / remote-agent): blocking round-trip
        // with no transfer-progress event.
        const { readFile } = await import("@tauri-apps/plugin-fs");
        const data = await readFile(clipEntry.path);
        await sessionWriteFile(sessionFileBrowserId, destPath, data);
        return false;
      }
      // sftp→session: not supported (no legacy SFTP source pane remains post-#2421)
      return false;
    };

    for (const clipEntry of clipboard.entries) {
      // A paste leg may drive the dedicated SFTP channel (event path owns the
      // success toast) or fall back to a byte-based round-trip that emits no
      // event; runMaybeTrackedTransfer surfaces the byte-based success itself
      // without double-toasting the SFTP path (#2906).
      const ok = await runMaybeTrackedTransfer("Paste", () => pasteOne(clipEntry), {
        loading: `Pasting ${clipEntry.name}…`,
        success: `Pasted ${clipEntry.name}`,
      });
      // Abort on first failure so a cut clipboard is not cleared and the user is
      // not left with a partial, silently-incomplete paste.
      if (!ok) return;
    }

    if (clipboard.operation === "cut") {
      useAppStore.getState().setFileClipboard(null);
    }

    refreshSession();
  }, [
    sessionFileBrowserId,
    sessionCurrentPath,
    refreshSession,
    sftpCapable,
    startRemoteCopy,
    startUpload,
  ]);

  return {
    fileEntries: sessionFileEntries,
    currentPath: sessionCurrentPath,
    isConnected: sessionFileBrowserId !== null,
    isLoading: sessionFileLoading,
    error: sessionFileError,
    navigateTo,
    navigateUp,
    refresh,
    dismissError,
    downloadFile,
    uploadFile,
    uploadFileFromPath,
    createDirectory,
    createFile,
    deleteEntry,
    renameEntry,
    setPermissions,
    setOwner,
    createSymlink,
    // chmod / chown / symlink map to SFTP `setstat` / `symlink`, so only an
    // SFTP-backed (SSH) session supports them; byte-based backends (Docker / FTP /
    // remote-agent) do not.
    supportsPermissions: sftpCapable,
    supportsOwner: sftpCapable,
    supportsSymlink: sftpCapable,
    openInVscode,
    copyEntry,
    cutEntry,
    pasteEntry,
  };
}
