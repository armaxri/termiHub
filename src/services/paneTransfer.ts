/**
 * The dual-pane transfer view's copy engine (PROD-007, #3558): copy files and
 * folders between the local disk and one remote session.
 *
 * Each file leg goes through the existing transfer machinery:
 *
 * - a **queue-capable** session (SFTP / FTP) registers a tracked transfer with
 *   `session_upload` / `session_download` and seeds its Transfer Queue row, so
 *   the file shows progress and can be paused, cancelled and retried;
 * - a **byte-based** session (Docker / remote agent) falls back to a blocking
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
  /** Whether the session drives the transfer queue (SFTP / FTP). */
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

/** Copy one file; resolves to whether the leg is tracked by the transfer queue. */
async function copyFile(
  from: PaneSide,
  src: string,
  dest: string,
  remote: PaneRemote
): Promise<boolean> {
  const { sessionId, queueCapable } = remote;
  if (from === "local") {
    if (queueCapable) {
      await sessionUpload(sessionId, src, dest, (transferId) =>
        seedTransferQueueRow({ transferId, sessionId, direction: "upload", remotePath: dest })
      );
      return true;
    }
    const { readFile } = await import("@tauri-apps/plugin-fs");
    await sessionWriteFile(sessionId, dest, await readFile(src));
    return false;
  }
  if (queueCapable) {
    await sessionDownload(sessionId, src, dest, (transferId) =>
      seedTransferQueueRow({ transferId, sessionId, direction: "download", remotePath: src })
    );
    return true;
  }
  const data = await sessionReadFile(sessionId, src);
  const { writeFile } = await import("@tauri-apps/plugin-fs");
  await writeFile(dest, data);
  return false;
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

/** Copy one entry (recursively for a folder); resolves to "any leg tracked". */
async function copyEntry(
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
    tracked = (await copyEntry(from, child, dest, remote)) || tracked;
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
      () => copyEntry(from, entry, destDir, remote),
      { loading: `Copying ${entry.name}…`, success: `Copied ${entry.name}` }
    );
    if (!ok) return false;
  }
  return true;
}
