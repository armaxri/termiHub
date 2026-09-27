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
  sessionVscodeOpenRemote,
  sessionHasExecCapability,
  sessionSupportsTransferQueue,
} from "@/services/api";
import { FileEntry } from "@/types/connection";
import { frontendLog } from "@/utils/frontendLog";
import {
  runBlockingTransfer,
  runMaybeTrackedTransfer,
  runTransfer,
  seedTransferQueueRow,
  pickPathOrReport,
} from "./transferFeedback";
import { errorMessage } from "@/utils/errorMessage";
import { joinDirPath, pasteVerbLabels, type PasteOptions } from "@/utils/fileDragMove";
import {
  pasteFileLeg,
  pasteFolderRecorded,
  startSessionUpload,
  type PasteTransport,
} from "./sessionFolderPaste";

/**
 * Hook for session-based file system operations.
 *
 * Backs every file-browser-capable connection type routed through the session
 * layer: remote-agent sessions, Docker, FTP, and — since the SFTP convergence
 * (#2421) — SSH. File ops flow through the active terminal session's file
 * browser capability (`session_*` commands) rather than a separate `SftpManager`
 * session.
 *
 * # Queued vs byte-based transfers (#2421, PROD-010)
 *
 * Two transport shapes back a session (mirroring the editor split in #2420):
 *
 * - A **queue-capable** session — SFTP-backed (SSH), FTP-backed or Docker — drives the
 *   rich transfer-queue engine: `session_download` / `session_upload` register a
 *   background transfer that keeps the listing live and feeds the Transfer Queue
 *   with progress/ETA/pause/resume/retry. The backend resolves the executor from
 *   the live session, so FTP credentials never cross into the frontend (PROD-010).
 * - A **byte-based** backend (remote-agent) cannot drive the queue, so
 *   transfers fall back to a blocking `session_read_file` / `session_write_file`
 *   round-trip.
 *
 * Two capability signals gate this:
 *
 * - {@link transferQueueCapable} — from the `session_supports_transfer_queue`
 *   probe (`true` for SFTP, FTP or Docker) — routes download/upload/local-paste-upload
 *   through the queue engine vs the byte-based fallback.
 * - {@link sftpCapable} — from the `session_has_exec_capability` probe, which
 *   **resolves** only for an SFTP-backed session — gates the SFTP-only features:
 *   VS Code remote open, chmod/chown/symlink, and the direct SFTP↔SFTP
 *   remote-copy stream. FTP has none of these, so it stays queue-capable but not
 *   `sftpCapable`.
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

  // Whether the current session can drive the rich transfer-queue engine — SFTP,
  // FTP (PROD-010) or Docker (#3567). Gates whether download/upload route through
  // the queue (progress/ETA/pause/resume/retry) or the blocking byte-based
  // fallback that a remote-agent session uses. Determined by the
  // `session_supports_transfer_queue` probe; `false` until it resolves, so the
  // brief pre-probe window (and a byte-based backend) stays on the fallback.
  const [transferQueueCapable, setTransferQueueCapable] = useState(false);

  useEffect(() => {
    setTransferQueueCapable(false);
    if (!sessionFileBrowserId) return;
    let cancelled = false;
    const sessionId = sessionFileBrowserId;
    sessionSupportsTransferQueue(sessionId)
      .then((supported) => {
        if (cancelled) return;
        setTransferQueueCapable(supported);
        frontendLog(
          "session_file_browser",
          `session ${sessionId} transfer-queue capable: ${supported}`
        );
      })
      .catch((err) => {
        if (cancelled) return;
        // A probe failure keeps the safe byte-based fallback.
        setTransferQueueCapable(false);
        frontendLog(
          "session_file_browser",
          `session ${sessionId} transfer-queue probe failed: ${errorMessage(err)}`
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
  const startUpload = startSessionUpload;

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
      const localPath = await pickPathOrReport(`Download "${fileName}"`, () =>
        save({ title: "Save file as...", defaultPath: fileName })
      );
      if (!localPath) return;
      if (transferQueueCapable) {
        // Queue-capable (SFTP/FTP/Docker): register a tracked transfer on the rich queue
        // engine — progress/ETA/pause/resume/retry (#2421, PROD-010).
        await runTransfer(
          "Download",
          () => startDownload(sessionFileBrowserId, remotePath, localPath),
          { loading: `Downloading ${fileName}…` }
        );
        return;
      }
      // Byte-based fallback (remote-agent): blocking round-trip
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
    [sessionFileBrowserId, transferQueueCapable, startDownload]
  );

  const uploadFile = useCallback(async () => {
    if (!sessionFileBrowserId) return;
    const localPath = await pickPathOrReport("Upload", async () => {
      const { open } = await import("@tauri-apps/plugin-dialog");
      return open({ title: "Select file to upload", multiple: false });
    });
    if (!localPath) return;
    const fileName = localPath.split("/").pop() ?? localPath.split("\\").pop() ?? "upload";
    const remotePath =
      sessionCurrentPath === "/" ? `/${fileName}` : `${sessionCurrentPath}/${fileName}`;
    if (transferQueueCapable) {
      // Queue-capable (SFTP/FTP/Docker): register a tracked transfer on the rich queue
      // engine — progress/ETA/pause/resume/retry (#2421, PROD-010).
      const ok = await runTransfer(
        "Upload",
        () => startUpload(sessionFileBrowserId, localPath, remotePath),
        { loading: `Uploading ${fileName}…` }
      );
      if (ok) refreshSession();
      return;
    }
    // Byte-based fallback (remote-agent): blocking round-trip
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
  }, [sessionFileBrowserId, sessionCurrentPath, refreshSession, transferQueueCapable, startUpload]);

  const uploadFileFromPath = useCallback(
    async (localPath: string) => {
      if (!sessionFileBrowserId) return;
      const parts = localPath.replace(/\\/g, "/").split("/");
      const fileName = parts[parts.length - 1] || "upload";
      const remotePath =
        sessionCurrentPath === "/" ? `/${fileName}` : `${sessionCurrentPath}/${fileName}`;
      if (transferQueueCapable) {
        // Queue-capable (SFTP/FTP/Docker): register a tracked transfer on the rich queue
        // engine — progress/ETA/pause/resume/retry (#2421, PROD-010).
        const ok = await runTransfer(
          "Upload",
          () => startUpload(sessionFileBrowserId, localPath, remotePath),
          { loading: `Uploading ${fileName}…` }
        );
        if (ok) refreshSession();
        return;
      }
      // Byte-based fallback (remote-agent): blocking round-trip
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
    [sessionFileBrowserId, sessionCurrentPath, refreshSession, transferQueueCapable, startUpload]
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

  const pasteEntry = useCallback(
    async (options?: PasteOptions) => {
      // An explicit clipboard (drag-to-move / Move to… dialog) is a one-shot
      // transfer that never touches — or clears — the user's copy/cut clipboard.
      const clipboard = options?.clipboard ?? currentFileBrowsersView().clipboard;
      if (!clipboard || !sessionFileBrowserId) return;

      const destSession = sessionFileBrowserId;
      const destDir = options?.destDir ?? sessionCurrentPath;
      const labels = pasteVerbLabels(options?.verb);

      // The clipboard's source session (and whether it is SFTP-backed) is constant
      // across every entry, so resolve it once rather than probing per file. A
      // session source keys on `terminalSessionId` — SSH flows through here too
      // since the convergence (#2421), so the retired `sftpSessionId` field is
      // unused; a same-session paste falls back to the active session id. `null`
      // for a local source.
      const srcSession =
        clipboard.sourceMode === "session" ? (clipboard.terminalSessionId ?? destSession) : null;
      const srcSftp =
        srcSession === null
          ? false
          : srcSession === destSession
            ? sftpCapable
            : await sessionHasExecCapability(srcSession)
                .then(() => true)
                .catch(() => false);

      const transport: PasteTransport = {
        operation: clipboard.operation,
        sourceMode: clipboard.sourceMode === "session" ? "session" : "local",
        srcSession,
        destSession,
        srcSftp,
        destSftp: sftpCapable,
        destQueueCapable: transferQueueCapable,
      };

      // Resolves to whether the leg drove the dedicated (event-emitting) channel.
      const pasteOne = async (clipEntry: FileEntry): Promise<boolean> => {
        const destPath = joinDirPath(destDir, clipEntry.name);
        // A folder copied file by file is recorded while it runs, so an
        // interrupted paste is reported after a restart (#3630).
        return clipEntry.isDirectory
          ? pasteFolderRecorded(transport, clipEntry.path, destPath)
          : pasteFileLeg(transport, clipEntry.path, destPath, true);
      };

      for (const clipEntry of clipboard.entries) {
        // A paste leg may drive the dedicated SFTP channel (event path owns the
        // success toast) or fall back to a byte-based round-trip that emits no
        // event; runMaybeTrackedTransfer surfaces the byte-based success itself
        // without double-toasting the SFTP path (#2906).
        const ok = await runMaybeTrackedTransfer(
          options?.verb ?? "Paste",
          () => pasteOne(clipEntry),
          {
            loading: `${labels.loading} ${clipEntry.name}…`,
            success: `${labels.done} ${clipEntry.name}`,
          }
        );
        // Abort on first failure so a cut clipboard is not cleared and the user is
        // not left with a partial, silently-incomplete paste.
        if (!ok) return;
      }

      if (clipboard.operation === "cut" && !options?.clipboard) {
        useAppStore.getState().setFileClipboard(null);
      }

      refreshSession();
    },
    [sessionFileBrowserId, sessionCurrentPath, refreshSession, sftpCapable, transferQueueCapable]
  );

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
    // Picks the remote drag-out staging path: a queue-capable (SFTP / FTP /
    // Docker) session stages through the transfer queue (#3457); byte-based
    // (agent) sessions are staged by the backend instead (#3491).
    supportsDragOut: transferQueueCapable,
    openInVscode,
    copyEntry,
    cutEntry,
    pasteEntry,
  };
}
