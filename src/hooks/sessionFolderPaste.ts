/**
 * The file-by-file paste engine behind a session file-browser paste
 * (`useSessionFileSystem.pasteEntry`), plus the persisted folder-paste
 * manifest that makes an interrupted folder paste visible after a restart
 * (#3630).
 *
 * A folder paste that crosses sessions (local → session, session → session, or
 * a byte-based backend) is copied one file at a time from the frontend. Only
 * the file in flight has a persisted transfer record, so after an app restart
 * the files that had not started yet would silently never be copied. To make
 * that visible, such a paste records a manifest before its first file and
 * removes it once the whole folder landed ({@link pasteFolderRecorded}). A
 * manifest still recorded at the next launch is shown as a notice with a
 * Retry ({@link retryInterruptedFolderPaste}) that continues the paste: it
 * walks the folder again and skips every file the destination already holds
 * with the same size, so only the missing (or partly written) files are copied.
 *
 * Why a manifest rather than planning the folder backend-side and queueing
 * every file up front (as `local_copy_start` does for local folders): session
 * ids do not survive a restart, so pre-queued session rows could not resume by
 * themselves anyway, and the byte-based legs (remote agents, mixed transports)
 * have no transfer queue at all. The manifest covers every variant the same
 * way and never reports a half-copied folder as complete.
 */
import {
  folderPasteBegin,
  folderPasteEnd,
  localListDir,
  sessionCopy,
  sessionCopyRemote,
  sessionDeleteFile,
  sessionHasExecCapability,
  sessionListFiles,
  sessionMkdir,
  sessionReadFile,
  sessionRenameFile,
  sessionSupportsTransferQueue,
  sessionUpload,
  sessionWriteFile,
  type FolderPasteEndpoint,
  type FolderPasteOperation,
  type InterruptedFolderPaste,
} from "@/services/api";
import { getAllTabsAcrossGroupTrees } from "@/store/layoutSelectors";
import type { FileEntry } from "@/types/connection";
import { errorMessage } from "@/utils/errorMessage";
import { frontendLog } from "@/utils/frontendLog";
import { seedTransferQueueRow } from "./transferFeedback";

/** Upload a local file over a session's transfer queue, seeding its queue row. */
export function startSessionUpload(
  sessionId: string,
  localPath: string,
  remotePath: string
): Promise<number> {
  return sessionUpload(sessionId, localPath, remotePath, (transferId) =>
    seedTransferQueueRow({ transferId, sessionId, direction: "upload", remotePath })
  );
}

/**
 * Stream a file between two SFTP-backed sessions as ONE tracked transfer,
 * seeding a single queue row keyed on the destination (PROD-0013).
 */
export function startSessionRemoteCopy(
  srcSession: string,
  srcPath: string,
  dstSession: string,
  dstPath: string
): Promise<number> {
  return sessionCopyRemote(srcSession, srcPath, dstSession, dstPath, (transferId) =>
    seedTransferQueueRow({
      transferId,
      sessionId: dstSession,
      direction: "upload",
      remotePath: dstPath,
    })
  );
}

/** Everything a paste needs to know about its two endpoints. */
export interface PasteTransport {
  operation: FolderPasteOperation;
  /** Local disk (`srcSession` is `null`) or a session. */
  sourceMode: "local" | "session";
  srcSession: string | null;
  destSession: string;
  /** The source session is SFTP-backed. */
  srcSftp: boolean;
  /** The destination session is SFTP-backed. */
  destSftp: boolean;
  /** The destination session drives the rich transfer queue (SFTP/FTP/Docker). */
  destQueueCapable: boolean;
  /**
   * Continue an interrupted folder paste (#3630): skip every file the
   * destination already holds with the same size, and never take the
   * single-operation shortcuts (a rename / server-side copy would act on a
   * partly copied destination).
   */
  continueExisting?: boolean;
}

/**
 * Copy ONE file entry from `srcPath` → `destPath`. Resolves to whether the leg
 * drove the dedicated (event-emitting) transfer channel — `true` lets the
 * caller defer the success toast to the event path, `false` marks a byte-based
 * round-trip that owns its own toast (#2906). `deleteSourceOnCut` is `false`
 * during a directory recursion (the whole source subtree is removed once,
 * after it has copied) and `true` for a top-level single-file cut.
 */
export async function pasteFileLeg(
  t: PasteTransport,
  srcPath: string,
  destPath: string,
  deleteSourceOnCut: boolean
): Promise<boolean> {
  if (t.sourceMode === "session") {
    const src = t.srcSession ?? t.destSession;
    if (t.operation === "cut" && src === t.destSession) {
      // Same-session move: a metadata rename with no transfer-progress event.
      await sessionRenameFile(t.destSession, srcPath, destPath);
      return false;
    }
    // Cross-session or copy. When BOTH endpoints are SFTP-backed, stream the
    // copy directly source→destination through the desktop as ONE tracked
    // transfer — no local temp file (PROD-0013). A byte-based endpoint
    // (Docker/FTP/agent) has no SFTP channel, so it keeps the read/write
    // fallback below.
    let tracked: boolean;
    if (t.destSftp && t.srcSftp) {
      await startSessionRemoteCopy(src, srcPath, t.destSession, destPath);
      tracked = true;
    } else {
      // Byte-based fallback: blocking read/write round-trip, which registers no
      // tracked transfer.
      const data = await sessionReadFile(src, srcPath);
      await sessionWriteFile(t.destSession, destPath, data);
      tracked = false;
    }
    if (t.operation === "cut" && deleteSourceOnCut) {
      await sessionDeleteFile(src, srcPath);
    }
    return tracked;
  }
  // local→session: upload the local file to the remote destination.
  if (t.destQueueCapable) {
    // Queue-capable (SFTP/FTP/Docker): a tracked transfer on the rich queue
    // engine (#2421, PROD-010).
    await startSessionUpload(t.destSession, srcPath, destPath);
    return true;
  }
  // Byte-based fallback (remote-agent): blocking round-trip with no
  // transfer-progress event.
  const { readFile } = await import("@tauri-apps/plugin-fs");
  const data = await readFile(srcPath);
  await sessionWriteFile(t.destSession, destPath, data);
  return false;
}

/**
 * Whether a folder paste completes in ONE backend operation (a same-session
 * rename, or a same-session server-side copy on SFTP) rather than file by file.
 */
export function isSingleOperationFolderPaste(t: PasteTransport): boolean {
  if (t.continueExisting || t.sourceMode !== "session") return false;
  const sameSession = (t.srcSession ?? t.destSession) === t.destSession;
  return sameSession && (t.operation === "cut" || t.destSftp);
}

/**
 * The destination's existing entries when continuing a paste, creating the
 * folder when it is missing. A fresh paste always creates the folder.
 */
async function prepareDestFolder(t: PasteTransport, destPath: string): Promise<FileEntry[]> {
  if (t.continueExisting) {
    try {
      return await sessionListFiles(t.destSession, destPath);
    } catch {
      // Not there yet: create it below and treat it as empty.
    }
  }
  await sessionMkdir(t.destSession, destPath);
  return [];
}

/** Whether the destination already holds a complete copy of `child`. */
function alreadyCopied(child: FileEntry, existing: FileEntry[]): boolean {
  return existing.some((e) => e.name === child.name && !e.isDirectory && e.size === child.size);
}

/**
 * Recursively copy a DIRECTORY from `srcDir` → `destPath` so a pasted folder
 * lands with ALL of its contents (audit PROD-004). Resolves to whether any leg
 * drove the dedicated (event-emitting) channel.
 */
export async function pasteFolderTree(
  t: PasteTransport,
  srcDir: string,
  destPath: string
): Promise<boolean> {
  if (isSingleOperationFolderPaste(t)) {
    if (t.operation === "cut") {
      // Same-session move: rename the directory in one metadata op.
      await sessionRenameFile(t.destSession, srcDir, destPath);
    } else {
      // Same-session copy on an SFTP-backed session: one server-side recursive
      // copy (#3201) — no desktop round-trip, no per-file enumeration.
      await sessionCopy(t.destSession, srcDir, destPath);
    }
    return false;
  }
  // Cross-session, byte-based, or local→session: recreate the directory on the
  // destination, then copy each child — recursing into subdirectories.
  const existing = await prepareDestFolder(t, destPath);
  const children =
    t.sourceMode === "local"
      ? await localListDir(srcDir)
      : await sessionListFiles(t.srcSession ?? t.destSession, srcDir);
  let tracked = false;
  for (const child of children) {
    const childDest = `${destPath}/${child.name}`;
    if (child.isDirectory) {
      tracked = (await pasteFolderTree(t, child.path, childDest)) || tracked;
    } else if (!(t.continueExisting && alreadyCopied(child, existing))) {
      tracked = (await pasteFileLeg(t, child.path, childDest, false)) || tracked;
    }
  }
  // Cross-session / byte-based cut: remove the copied source subtree once the
  // whole tree has landed (a local source is never mutated by a paste).
  if (t.operation === "cut" && t.sourceMode === "session") {
    await sessionDeleteFile(t.srcSession ?? t.destSession, srcDir);
  }
  return tracked;
}

/** Describe a session endpoint from the tab that owns it (for the manifest). */
export function sessionEndpoint(sessionId: string, path: string): FolderPasteEndpoint {
  const tab = getAllTabsAcrossGroupTrees().find((t) => t.sessionId === sessionId);
  return {
    sessionId,
    connectionId: tab?.connectionId ?? null,
    label: tab?.title ?? null,
    path,
  };
}

/** The manifest endpoints of a paste of `srcDir` → `destPath`. */
function manifestEndpoints(
  t: PasteTransport,
  srcDir: string,
  destPath: string
): [FolderPasteEndpoint, FolderPasteEndpoint] {
  const source =
    t.sourceMode === "local"
      ? { sessionId: null, connectionId: null, label: "Local", path: srcDir }
      : sessionEndpoint(t.srcSession ?? t.destSession, srcDir);
  return [source, sessionEndpoint(t.destSession, destPath)];
}

/**
 * {@link pasteFolderTree}, recorded as a folder-paste manifest while it runs
 * when it is copied file by file (#3630). The manifest is removed only once
 * the whole folder landed, so a paste interrupted by a quit, crash or failure
 * is reported after the next launch rather than silently left half-copied.
 * Recording is best-effort: a persistence failure never blocks the paste.
 */
export async function pasteFolderRecorded(
  t: PasteTransport,
  srcDir: string,
  destPath: string
): Promise<boolean> {
  if (isSingleOperationFolderPaste(t)) return pasteFolderTree(t, srcDir, destPath);
  const [source, destination] = manifestEndpoints(t, srcDir, destPath);
  let pasteId: string | null = null;
  try {
    pasteId = await folderPasteBegin(t.operation, source, destination);
  } catch (err) {
    frontendLog("folder_paste", `Could not record folder paste: ${errorMessage(err)}`);
  }
  const tracked = await pasteFolderTree(t, srcDir, destPath);
  if (pasteId) {
    try {
      await folderPasteEnd(pasteId);
    } catch (err) {
      frontendLog("folder_paste", `Could not clear folder paste: ${errorMessage(err)}`);
    }
  }
  return tracked;
}

/**
 * The live session an endpoint of an interrupted paste now runs on: the same
 * session when it is still open, otherwise the open tab of the same saved
 * connection (session ids do not survive a restart). `null` when neither is
 * open.
 */
export function resolveLiveSession(endpoint: FolderPasteEndpoint): string | null {
  const tabs = getAllTabsAcrossGroupTrees();
  if (endpoint.sessionId && tabs.some((t) => t.sessionId === endpoint.sessionId)) {
    return endpoint.sessionId;
  }
  if (!endpoint.connectionId) return null;
  return (
    tabs.find((t) => t.connectionId === endpoint.connectionId && t.sessionId)?.sessionId ?? null
  );
}

/** A short display name for an endpoint (its label, else its path). */
export function endpointLabel(endpoint: FolderPasteEndpoint): string {
  return endpoint.label ?? endpoint.path;
}

/** The last path segment of a folder path. */
export function folderName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Raised when an endpoint of an interrupted paste has no open session. */
export class FolderPasteEndpointUnavailable extends Error {
  constructor(endpoint: FolderPasteEndpoint) {
    super(`Connect to ${endpointLabel(endpoint)} first, then retry.`);
    this.name = "FolderPasteEndpointUnavailable";
  }
}

async function probeSftp(sessionId: string): Promise<boolean> {
  return sessionHasExecCapability(sessionId)
    .then(() => true)
    .catch(() => false);
}

/**
 * Continue an interrupted folder paste (#3630): resolve both endpoints to
 * their live sessions and paste the folder again in continue mode, copying
 * only the files the destination does not yet hold completely. Recorded like
 * any folder paste, so a second interruption is reported again. Rejects with
 * {@link FolderPasteEndpointUnavailable} when an endpoint is not connected.
 */
export async function retryInterruptedFolderPaste(paste: InterruptedFolderPaste): Promise<boolean> {
  const destSession = resolveLiveSession(paste.destination);
  if (!destSession) throw new FolderPasteEndpointUnavailable(paste.destination);
  const local = !paste.source.sessionId;
  const srcSession = local ? null : resolveLiveSession(paste.source);
  if (!local && !srcSession) throw new FolderPasteEndpointUnavailable(paste.source);
  const [destSftp, srcSftp, destQueueCapable] = await Promise.all([
    probeSftp(destSession),
    srcSession ? probeSftp(srcSession) : Promise.resolve(false),
    sessionSupportsTransferQueue(destSession).catch(() => false),
  ]);
  const t: PasteTransport = {
    operation: paste.operation,
    sourceMode: local ? "local" : "session",
    srcSession,
    destSession,
    srcSftp,
    destSftp,
    destQueueCapable,
    continueExisting: true,
  };
  return pasteFolderRecorded(t, paste.source.path, paste.destination.path);
}
