/**
 * The one local ↔ session copy engine (PROD-007 #3558, unified in #3563):
 * copy files and folders between the local disk and one remote session. It
 * backs the dual-pane transfer view, the sidebar's local → session paste
 * (`sessionFolderPaste.pasteFileLeg`), its session → local paste
 * (`useLocalFileSystem.pasteEntry`), the session browser's Upload / Download
 * buttons and OS-drop upload (`useSessionFileSystem`) and the drag-out staging
 * downloads (`useFileDragOut`, #3913).
 *
 * Each file leg goes through the existing transfer machinery:
 *
 * - a **queue-capable** session (SFTP / FTP / Docker, or an agent-hosted session on
 *   an agent with ranged file slices, #3587) registers a tracked transfer with
 *   `session_upload` / `session_download` and seeds its Transfer Queue row, so
 *   the file shows progress and can be paused, cancelled and retried;
 * - a **byte-based** session (an older agent) falls back to a blocking copy the
 *   backend does itself (`session_upload_local_file` /
 *   `session_download_to_local_file`), so the webview never touches the local
 *   file (#3115).
 *
 * A folder is recreated at the destination (an existing one is merged into)
 * and its tree copied file by file.
 */

import {
  localListDir,
  localMkdir,
  sessionDownload,
  sessionDownloadToLocalFile,
  sessionListFiles,
  sessionMkdir,
  sessionSupportsTransferQueue,
  sessionUpload,
  sessionUploadLocalFile,
} from "@/services/api";
import { runMaybeTrackedTransfer, seedTransferQueueRow } from "@/hooks/transferFeedback";
import type { FileEntry } from "@/types/connection";
import { joinPath } from "@/utils/paths";

/** Which pane of the transfer view. */
export type PaneSide = "local" | "remote";

/** The remote session the transfer view is attached to. */
export interface PaneRemote {
  sessionId: string;
  /** Whether the session drives the transfer queue (SFTP / FTP / Docker). */
  queueCapable: boolean;
}

/** One copy request between the panes. */
export interface PaneCopyRequest {
  /** The pane the entries come from; they land in the other one. */
  from: PaneSide;
  entries: FileEntry[];
  /** The destination directory in the other pane. */
  destDir: string;
  remote: PaneRemote;
}

/**
 * Start a queued upload of a local file to a session, seeding its Transfer Queue
 * row. `onRegistered` also sees the transfer id (a folder paste links it to its
 * manifest, #3643). Resolves with the bytes transferred once it completes.
 */
function startQueuedUpload(
  sessionId: string,
  localPath: string,
  remotePath: string,
  onRegistered?: (transferId: string) => void
): Promise<number> {
  return sessionUpload(sessionId, localPath, remotePath, (transferId) => {
    seedTransferQueueRow({ transferId, sessionId, direction: "upload", remotePath });
    onRegistered?.(transferId);
  });
}

/**
 * Start a queued download of a session file to the local disk, seeding its
 * Transfer Queue row. `onRegistered` also sees the transfer id. Resolves with
 * the bytes transferred once it completes.
 */
export function startQueuedDownload(
  sessionId: string,
  remotePath: string,
  localPath: string,
  onRegistered?: (transferId: string) => void
): Promise<number> {
  return sessionDownload(sessionId, remotePath, localPath, (transferId) => {
    seedTransferQueueRow({ transferId, sessionId, direction: "download", remotePath });
    onRegistered?.(transferId);
  });
}

/**
 * Copy one local file to a session: a queued upload on a queue-capable
 * session, a backend-side byte copy otherwise. Resolves to whether the leg is tracked
 * by the transfer queue (whose event path then owns the success toast).
 */
export async function uploadLocalFile(
  remote: PaneRemote,
  localPath: string,
  remotePath: string,
  onRegistered?: (transferId: string) => void
): Promise<boolean> {
  if (remote.queueCapable) {
    await startQueuedUpload(remote.sessionId, localPath, remotePath, onRegistered);
    return true;
  }
  await sessionUploadLocalFile(remote.sessionId, localPath, remotePath);
  return false;
}

/**
 * Copy one session file to the local disk: a queued download on a
 * queue-capable session, a backend-side byte copy otherwise. Resolves to whether the
 * leg is tracked by the transfer queue.
 */
export async function downloadToLocal(
  remote: PaneRemote,
  remotePath: string,
  localPath: string,
  onRegistered?: (transferId: string) => void
): Promise<boolean> {
  const { sessionId, queueCapable } = remote;
  if (queueCapable) {
    await startQueuedDownload(sessionId, remotePath, localPath, onRegistered);
    return true;
  }
  await sessionDownloadToLocalFile(sessionId, remotePath, localPath);
  return false;
}

/**
 * Describe a session as a transfer endpoint. A failed capability probe keeps
 * the safe byte-based fallback.
 */
export async function probePaneRemote(sessionId: string): Promise<PaneRemote> {
  const queueCapable = await sessionSupportsTransferQueue(sessionId).catch(() => false);
  return { sessionId, queueCapable };
}

/**
 * Options of a copy between the panes.
 */
interface PaneCopyOptions {
  /**
   * Continue an interrupted folder paste (#3912): skip every file the
   * destination already holds with the same size, so only the missing (or
   * partly written) files are copied again.
   */
  continueExisting?: boolean;
  /**
   * Sees the id of every tracked file transfer, so a recorded folder paste can
   * link it to its manifest (#3643).
   */
  onRegistered?: (transferId: string) => void;
}

/** Copy one file; resolves to whether the leg is tracked by the transfer queue. */
function copyFile(
  from: PaneSide,
  src: string,
  dest: string,
  remote: PaneRemote,
  onRegistered?: (transferId: string) => void
): Promise<boolean> {
  return from === "local"
    ? uploadLocalFile(remote, src, dest, onRegistered)
    : downloadToLocal(remote, src, dest, onRegistered);
}

/** List `dir` on one side of the transfer. */
function listSide(side: PaneSide, dir: string, remote: PaneRemote): Promise<FileEntry[]> {
  return side === "remote" ? sessionListFiles(remote.sessionId, dir) : localListDir(dir);
}

/**
 * Create `dest` on the destination side. A failure is ignored when the folder
 * turns out to exist already (the copy then merges into it).
 */
async function ensureDir(to: PaneSide, dest: string, remote: PaneRemote): Promise<void> {
  try {
    await (to === "remote" ? sessionMkdir(remote.sessionId, dest) : localMkdir(dest));
  } catch (err) {
    await listSide(to, dest, remote).catch(() => {
      throw err;
    });
  }
}

/**
 * The destination folder's existing entries when continuing a paste, creating
 * the folder when it is missing. A fresh copy always creates (or merges into)
 * the folder and treats it as empty.
 */
async function prepareDestFolder(
  to: PaneSide,
  dest: string,
  remote: PaneRemote,
  continueExisting: boolean
): Promise<FileEntry[]> {
  if (continueExisting) {
    try {
      return await listSide(to, dest, remote);
    } catch {
      // Not there yet: create it below and treat it as empty.
    }
  }
  await ensureDir(to, dest, remote);
  return [];
}

/** Whether the destination already holds a complete copy of `child`. */
function alreadyCopied(child: FileEntry, existing: FileEntry[]): boolean {
  return existing.some((e) => e.name === child.name && !e.isDirectory && e.size === child.size);
}

/**
 * Copy the folder `srcDir` to `destPath` on the other side, recursively and
 * file by file. Resolves to whether any leg is tracked by the transfer queue.
 */
export async function copyPaneFolder(
  from: PaneSide,
  srcDir: string,
  destPath: string,
  remote: PaneRemote,
  options: PaneCopyOptions = {}
): Promise<boolean> {
  const to: PaneSide = from === "local" ? "remote" : "local";
  const existing = await prepareDestFolder(to, destPath, remote, !!options.continueExisting);
  const children = await listSide(from, srcDir, remote);
  let tracked = false;
  for (const child of children) {
    const childDest = joinPath(destPath, child.name);
    if (child.isDirectory) {
      tracked = (await copyPaneFolder(from, child.path, childDest, remote, options)) || tracked;
    } else if (!(options.continueExisting && alreadyCopied(child, existing))) {
      tracked =
        (await copyFile(from, child.path, childDest, remote, options.onRegistered)) || tracked;
    }
  }
  return tracked;
}

/**
 * Copy one entry into `destDir` of the other side (recursively for a folder),
 * with no feedback of its own. Resolves to whether any leg is tracked by the
 * transfer queue.
 */
export async function copyPaneEntry(
  from: PaneSide,
  entry: FileEntry,
  destDir: string,
  remote: PaneRemote,
  options: PaneCopyOptions = {}
): Promise<boolean> {
  const dest = joinPath(destDir, entry.name);
  if (!entry.isDirectory) return copyFile(from, entry.path, dest, remote, options.onRegistered);
  return copyPaneFolder(from, entry.path, dest, remote, options);
}

/**
 * Copy `entries` from one pane into `destDir` of the other. Each top-level
 * entry gets its own pending / success / error feedback; the copy stops at the
 * first failure. Resolves to whether every entry was copied.
 */
export async function copyBetweenPanes(request: PaneCopyRequest): Promise<boolean> {
  const { from, entries, destDir, remote } = request;
  for (const entry of entries) {
    const ok = await runMaybeTrackedTransfer(
      "Copy",
      () => copyPaneEntry(from, entry, destDir, remote),
      { loading: `Copying ${entry.name}…`, success: `Copied ${entry.name}` }
    );
    if (!ok) return false;
  }
  return true;
}
