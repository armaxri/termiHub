import { useCallback, useEffect, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "@/store/appStore";
import { currentFileBrowsersView } from "@/store/fileBrowsersBridge";
import { useProjectedFileBrowsers } from "@/store/useProjectedFileBrowsers";
import {
  sessionWriteFile,
  sessionDeleteFile,
  sessionRenameFile,
  sessionMkdir,
  sessionSetPermissions,
  sessionSetOwner,
  sessionCreateSymlink,
  sessionVscodeOpenRemote,
  sessionHasExecCapability,
  sessionSupportsTransferQueue,
  localStat,
} from "@/services/api";
import { FileEntry } from "@/types/connection";
import { frontendLog } from "@/utils/frontendLog";
import {
  baseName,
  runBlockingTransfer,
  runMaybeTrackedTransfer,
  runTransfer,
  pickPathOrReport,
} from "./transferFeedback";
import { errorMessage } from "@/utils/errorMessage";
import { joinDirPath, pasteVerbLabels, type PasteOptions } from "@/utils/fileDragMove";
import {
  pasteFileLeg,
  pasteFolderRecorded,
  pasteRemoteFolderToLocal,
  probeRemoteCopy,
  uploadLocalFolderToSession,
  type PasteTransport,
} from "./sessionFolderPaste";
import { downloadToLocal, uploadLocalFile } from "@/services/paneTransfer";

/** Toast wording for one Upload / Download button leg. */
const LEG_LABELS = {
  Download: { pending: "Downloading", done: "Downloaded" },
  Upload: { pending: "Uploading", done: "Uploaded" },
} as const;

/**
 * Run one Upload / Download leg of the shared pane transfer engine (#3913)
 * with the feedback its transport needs. A queued leg defers its success toast
 * to the transfer-progress event path (`runTransfer`); a byte-based leg emits
 * no event, so it owns its loading → success / error toast (UX-017, #2906).
 * Resolves to whether the leg succeeded.
 */
function runButtonLeg(
  queued: boolean,
  verb: keyof typeof LEG_LABELS,
  fileName: string,
  leg: () => Promise<unknown>
): Promise<boolean> {
  const labels = LEG_LABELS[verb];
  const loading = `${labels.pending} ${fileName}…`;
  if (queued) return runTransfer(verb, leg, { loading });
  return runBlockingTransfer(leg, {
    loading,
    success: `${labels.done} ${fileName}`,
    errorLabel: `${verb} "${fileName}"`,
  });
}

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
 * - An agent-hosted session drives the same queue when its agent serves ranged
 *   file slices (`fileRanges`, #3587), one `connection.files.*` request per chunk.
 * - A **byte-based** backend (an older agent) cannot drive the queue, so
 *   transfers fall back to a blocking `session_read_file` / `session_write_file`
 *   round-trip.
 *
 * Two capability signals gate this:
 *
 * - {@link transferQueueCapable} — from the `session_supports_transfer_queue`
 *   probe (`true` for SFTP, FTP, Docker or a ranged agent session) — routes download/upload/local-paste-upload
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

  // The Upload / Download buttons and the OS-drop upload copy through the
  // shared pane transfer engine (#3913): a queued transfer with a seeded
  // Transfer Queue row on a queue-capable session (SFTP / FTP / Docker —
  // progress, pause, cancel, retry; also an agent session with ranged slices),
  // a byte round-trip otherwise.
  //
  // A folder (only reachable from a multi-select Download) is never handed to a
  // single-file `session_download` (#3944): the user picks a target folder and
  // the engine copies the tree into it, one queued or byte leg per file. Both
  // folder directions are recorded in the interrupted-paste manifest (#3983).
  const downloadFolder = useCallback(
    async (sessionId: string, remotePath: string, folderName: string) => {
      const label = `Download "${folderName}"`;
      const targetDir = await pickPathOrReport(label, async () => {
        const { open } = await import("@tauri-apps/plugin-dialog");
        return open({
          title: `Download folder "${folderName}" to...`,
          directory: true,
          multiple: false,
        });
      });
      if (!targetDir) return;
      const remote = { sessionId, queueCapable: transferQueueCapable };
      // Recorded in the interrupted-paste manifest like a session → local
      // paste (#3983), so a download cut short by a quit is listed and
      // resumable after a restart.
      const destPath = joinDirPath(targetDir, folderName);
      await runMaybeTrackedTransfer(
        label,
        () => pasteRemoteFolderToLocal("copy", remote, remotePath, destPath),
        { loading: `Downloading ${folderName}…`, success: `Downloaded ${folderName}` }
      );
    },
    [transferQueueCapable]
  );

  const downloadFile = useCallback(
    async (remotePath: string, fileName: string, isDirectory = false) => {
      if (!sessionFileBrowserId) return;
      if (isDirectory) {
        await downloadFolder(sessionFileBrowserId, remotePath, fileName);
        return;
      }
      const localPath = await pickPathOrReport(`Download "${fileName}"`, () =>
        save({ title: "Save file as...", defaultPath: fileName })
      );
      if (!localPath) return;
      const remote = { sessionId: sessionFileBrowserId, queueCapable: transferQueueCapable };
      await runButtonLeg(transferQueueCapable, "Download", fileName, () =>
        downloadToLocal(remote, remotePath, localPath)
      );
    },
    [sessionFileBrowserId, transferQueueCapable, downloadFolder]
  );

  // A dropped local folder (#3966) is copied into the current folder by the
  // same engine, one queued or byte leg per file, instead of a single-file
  // `session_upload` of the folder path. If the local stat fails, the path
  // takes the single-file upload, and the backend guard refuses a folder
  // there with a clear error (#3944).
  const uploadFileFromPath = useCallback(
    async (localPath: string) => {
      if (!sessionFileBrowserId) return;
      const fileName = baseName(localPath) || "upload";
      const remote = { sessionId: sessionFileBrowserId, queueCapable: transferQueueCapable };
      let entry: FileEntry | null = null;
      try {
        entry = await localStat(localPath);
      } catch {
        // Unknown kind: take the single-file upload (see above).
      }
      let ok: boolean;
      if (entry?.isDirectory) {
        // Recorded in the interrupted-paste manifest like a local → session
        // paste (#3983), so an upload cut short by a quit is listed and
        // resumable after a restart.
        const destPath = joinDirPath(sessionCurrentPath, fileName);
        ok = await runMaybeTrackedTransfer(
          `Upload "${fileName}"`,
          () => uploadLocalFolderToSession(remote, localPath, destPath),
          { loading: `Uploading ${fileName}…`, success: `Uploaded ${fileName}` }
        );
      } else {
        const remotePath = joinDirPath(sessionCurrentPath, fileName);
        ok = await runButtonLeg(transferQueueCapable, "Upload", fileName, () =>
          uploadLocalFile(remote, localPath, remotePath)
        );
      }
      if (ok) refreshSession();
    },
    [sessionFileBrowserId, sessionCurrentPath, refreshSession, transferQueueCapable]
  );

  const uploadFile = useCallback(async () => {
    if (!sessionFileBrowserId) return;
    const localPath = await pickPathOrReport("Upload", async () => {
      const { open } = await import("@tauri-apps/plugin-dialog");
      return open({ title: "Select file to upload", multiple: false });
    });
    if (!localPath) return;
    await uploadFileFromPath(localPath);
  }, [sessionFileBrowserId, uploadFileFromPath]);

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

      // The clipboard's source session (and whether it can stream a remote
      // copy) is constant across every entry, so resolve it once rather than
      // probing per file. A session source keys on `terminalSessionId` — SSH
      // flows through here too since the convergence (#2421), so the retired
      // `sftpSessionId` field is unused; a same-session paste falls back to the
      // active session id. `null` for a local source.
      const srcSession =
        clipboard.sourceMode === "session" ? (clipboard.terminalSessionId ?? destSession) : null;
      // Both ends must stream (SFTP or Docker) for a tracked remote copy
      // (#3586); a local source never needs the probe.
      const [srcRemoteCopy, destRemoteCopy] =
        srcSession === null
          ? [false, false]
          : await Promise.all([
              probeRemoteCopy(srcSession),
              srcSession === destSession ? null : probeRemoteCopy(destSession),
            ]).then(([src, dest]) => [src, dest ?? src]);

      const transport: PasteTransport = {
        operation: clipboard.operation,
        sourceMode: clipboard.sourceMode === "session" ? "session" : "local",
        srcSession,
        destSession,
        srcRemoteCopy,
        destRemoteCopy,
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
