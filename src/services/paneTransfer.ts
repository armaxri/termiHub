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
 * - a **queue-capable** session (SFTP / FTP / Docker) registers a tracked transfer with
 *   `session_upload` / `session_download` and seeds its Transfer Queue row, so
 *   the file shows progress and can be paused, cancelled and retried;
 * - a **byte-based** session (remote agent) falls back to a blocking
 *   read/write round-trip, as the sidebar browser does.
 *
 * A folder is recreated at the destination (an existing one is merged into)
 * and its tree copied file by file.
 */

import {
  localListDir,
  localMkdir,
  sessionDownload,
  sessionListFiles,
  sessionMkdir,
  sessionReadFile,
  sessionSupportsTransferQueue,
  sessionUpload,
  sessionWriteFile,
} from "@/services/api";
import { runMaybeTrackedTransfer, seedTransferQueueRow } from "@/hooks/transferFeedback";
import type { FileEntry } from "@/types/connection";
import { joinDirPath } from "@/utils/fileDragMove";

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
 * session, a byte round-trip otherwise. Resolves to whether the leg is tracked
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
  const { readFile } = await import("@tauri-apps/plugin-fs");
  await sessionWriteFile(remote.sessionId, remotePath, await readFile(localPath));
  return false;
}

/**
 * Copy one session file to the local disk: a queued download on a
 * queue-capable session, a byte round-trip otherwise. Resolves to whether the
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
  const data = await sessionReadFile(sessionId, remotePath);
  const { writeFile } = await import("@tauri-apps/plugin-fs");
  await writeFile(localPath, data);
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

/** Copy one file; resolves to whether the leg is tracked by the transfer queue. */
function copyFile(from: PaneSide, src: string, dest: string, remote: PaneRemote): Promise<boolean> {
  return from === "local" ? uploadLocalFile(remote, src, dest) : downloadToLocal(remote, src, dest);
}

/**
 * Create `dest` on the destination side. A failure is ignored when the folder
 * turns out to exist already (the copy then merges into it).
 */
async function ensureDir(to: PaneSide, dest: string, remote: PaneRemote): Promise<void> {
  const mkdir = () => (to === "remote" ? sessionMkdir(remote.sessionId, dest) : localMkdir(dest));
  const exists = () =>
    to === "remote" ? sessionListFiles(remote.sessionId, dest) : localListDir(dest);
  try {
    await mkdir();
  } catch (err) {
    await exists().catch(() => {
      throw err;
    });
  }
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
  remote: PaneRemote
): Promise<boolean> {
  const dest = joinDirPath(destDir, entry.name);
  if (!entry.isDirectory) return copyFile(from, entry.path, dest, remote);

  await ensureDir(from === "local" ? "remote" : "local", dest, remote);
  const children =
    from === "local"
      ? await localListDir(entry.path)
      : await sessionListFiles(remote.sessionId, entry.path);
  let tracked = false;
  for (const child of children) {
    tracked = (await copyPaneEntry(from, child, dest, remote)) || tracked;
  }
  return tracked;
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
