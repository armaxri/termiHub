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
  sessionListFiles,
  sessionCopy,
  sessionSetPermissions,
  sessionSetOwner,
  sessionCreateSymlink,
  sessionDownload,
  sessionUpload,
  sessionCopyRemote,
  sessionVscodeOpenRemote,
  sessionHasExecCapability,
  sessionSupportsTransferQueue,
  localListDir,
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
 * - A **queue-capable** session — SFTP-backed (SSH) or FTP-backed — drives the
 *   rich transfer-queue engine: `session_download` / `session_upload` register a
 *   background transfer that keeps the listing live and feeds the Transfer Queue
 *   with progress/ETA/pause/resume/retry. The backend resolves the executor from
 *   the live session, so FTP credentials never cross into the frontend (PROD-010).
 * - A **byte-based** backend (Docker / remote-agent) cannot drive the queue, so
 *   transfers fall back to a blocking `session_read_file` / `session_write_file`
 *   round-trip.
 *
 * Two capability signals gate this:
 *
 * - {@link transferQueueCapable} — from the `session_supports_transfer_queue`
 *   probe (`true` for SFTP or FTP) — routes download/upload/local-paste-upload
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

  // Whether the current session can drive the rich transfer-queue engine — SFTP
  // or FTP (PROD-010). Gates whether download/upload route through the queue
  // (progress/ETA/pause/resume/retry) or the blocking byte-based fallback that a
  // Docker/remote-agent session uses. Determined by the
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
      const localPath = await pickPathOrReport(`Download "${fileName}"`, () =>
        save({ title: "Save file as...", defaultPath: fileName })
      );
      if (!localPath) return;
      if (transferQueueCapable) {
        // Queue-capable (SFTP/FTP): register a tracked transfer on the rich queue
        // engine — progress/ETA/pause/resume/retry (#2421, PROD-010).
        await runTransfer(
          "Download",
          () => startDownload(sessionFileBrowserId, remotePath, localPath),
          { loading: `Downloading ${fileName}…` }
        );
        return;
      }
      // Byte-based fallback (Docker / remote-agent): blocking round-trip
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
      // Queue-capable (SFTP/FTP): register a tracked transfer on the rich queue
      // engine — progress/ETA/pause/resume/retry (#2421, PROD-010).
      const ok = await runTransfer(
        "Upload",
        () => startUpload(sessionFileBrowserId, localPath, remotePath),
        { loading: `Uploading ${fileName}…` }
      );
      if (ok) refreshSession();
      return;
    }
    // Byte-based fallback (Docker / remote-agent): blocking round-trip
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
        // Queue-capable (SFTP/FTP): register a tracked transfer on the rich queue
        // engine — progress/ETA/pause/resume/retry (#2421, PROD-010).
        const ok = await runTransfer(
          "Upload",
          () => startUpload(sessionFileBrowserId, localPath, remotePath),
          { loading: `Uploading ${fileName}…` }
        );
        if (ok) refreshSession();
        return;
      }
      // Byte-based fallback (Docker / remote-agent): blocking round-trip
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

      // Copy ONE file entry from `srcPath` → `destPath`. Resolves to whether the
      // leg drove the dedicated (event-emitting) transfer channel — `true` lets the
      // caller defer the success toast to the event path, `false` marks a byte-based
      // round-trip that owns its own toast (#2906). `deleteSourceOnCut` is `false`
      // during a directory recursion (the whole source subtree is removed once,
      // after it has copied) and `true` for a top-level single-file cut.
      const pasteFile = async (
        srcPath: string,
        destPath: string,
        deleteSourceOnCut: boolean
      ): Promise<boolean> => {
        if (clipboard.sourceMode === "session") {
          const src = srcSession ?? destSession;
          if (clipboard.operation === "cut" && src === destSession) {
            // Same-session move: a metadata rename with no transfer-progress event.
            await sessionRenameFile(destSession, srcPath, destPath);
            return false;
          }
          // Cross-session or copy. When BOTH endpoints are SFTP-backed, stream the
          // copy directly source→destination through the desktop as ONE tracked
          // transfer — no local temp file (PROD-0013). This replaces the pre-#2421
          // download-to-temp + upload dance (two rows + a local disk round-trip).
          // The single row's name and remote path come from the destination remote
          // path (#1531/#1573); the backend derives `file_name` from it. A
          // byte-based endpoint (Docker/FTP/agent) has no SFTP channel, so it keeps
          // the read/write fallback below.
          let tracked: boolean;
          if (sftpCapable && srcSftp) {
            await startRemoteCopy(src, srcPath, destSession, destPath);
            tracked = true;
          } else {
            // Byte-based fallback (Docker / FTP / remote-agent, or a mixed
            // transport where an endpoint has no SFTP channel): blocking read/write
            // round-trip, which registers no tracked transfer.
            const data = await sessionReadFile(src, srcPath);
            await sessionWriteFile(destSession, destPath, data);
            tracked = false;
          }
          if (clipboard.operation === "cut" && deleteSourceOnCut) {
            await sessionDeleteFile(src, srcPath);
          }
          return tracked;
        }
        // local→session: upload the local file to the remote destination.
        if (transferQueueCapable) {
          // Queue-capable (SFTP/FTP): register a tracked transfer on the rich queue
          // engine (#2421, PROD-010).
          await startUpload(destSession, srcPath, destPath);
          return true;
        }
        // Byte-based fallback (Docker / remote-agent): blocking round-trip with no
        // transfer-progress event.
        const { readFile } = await import("@tauri-apps/plugin-fs");
        const data = await readFile(srcPath);
        await sessionWriteFile(destSession, destPath, data);
        return false;
      };

      // Recursively copy a DIRECTORY from `srcDir` → `destPath` so a pasted folder
      // lands with ALL of its contents instead of being silently dropped (audit
      // PROD-004 — the pre-fix path treated every clipboard entry as a single file).
      // Resolves to whether any leg drove the dedicated (event-emitting) channel.
      const pasteDirectory = async (srcDir: string, destPath: string): Promise<boolean> => {
        // Same-session move: rename the directory in one metadata op (recursive
        // server-side); no per-file work.
        if (
          clipboard.sourceMode === "session" &&
          clipboard.operation === "cut" &&
          srcSession === destSession
        ) {
          await sessionRenameFile(destSession, srcDir, destPath);
          return false;
        }
        // Same-session copy on an SFTP-backed session: one server-side recursive
        // copy via the file-browser `copy()` capability (#3201) — no desktop
        // round-trip, no per-file enumeration. Byte-based backends reject
        // `session_copy`, so they fall through to the manual recursion below.
        if (
          clipboard.sourceMode === "session" &&
          clipboard.operation === "copy" &&
          srcSession === destSession &&
          sftpCapable
        ) {
          await sessionCopy(destSession, srcDir, destPath);
          return false;
        }
        // Cross-session, byte-based, or local→session: recreate the directory on
        // the destination, then copy each child — recursing into subdirectories and
        // transferring each file (reusing the session transfer queue / byte
        // fallback via `pasteFile`).
        await sessionMkdir(destSession, destPath);
        const children =
          clipboard.sourceMode === "local"
            ? await localListDir(srcDir)
            : await sessionListFiles(srcSession ?? destSession, srcDir);
        let tracked = false;
        for (const child of children) {
          const childDest = `${destPath}/${child.name}`;
          const childTracked = child.isDirectory
            ? await pasteDirectory(child.path, childDest)
            : await pasteFile(child.path, childDest, false);
          tracked = tracked || childTracked;
        }
        // Cross-session / byte-based cut: remove the copied source subtree once the
        // whole tree has landed (a same-session cut renamed above and never reaches
        // here; a local source is never mutated by a paste).
        if (clipboard.operation === "cut" && clipboard.sourceMode === "session") {
          await sessionDeleteFile(srcSession ?? destSession, srcDir);
        }
        return tracked;
      };

      // Resolves to whether the leg drove the dedicated (event-emitting) channel.
      const pasteOne = async (clipEntry: FileEntry): Promise<boolean> => {
        const destPath = joinDirPath(destDir, clipEntry.name);
        return clipEntry.isDirectory
          ? pasteDirectory(clipEntry.path, destPath)
          : pasteFile(clipEntry.path, destPath, true);
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
    [
      sessionFileBrowserId,
      sessionCurrentPath,
      refreshSession,
      sftpCapable,
      transferQueueCapable,
      startRemoteCopy,
      startUpload,
    ]
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
    // Remote drag-out stages files through the transfer queue (#3457), so only
    // a queue-capable (SFTP / FTP) session supports it.
    supportsDragOut: transferQueueCapable,
    openInVscode,
    copyEntry,
    cutEntry,
    pasteEntry,
  };
}
