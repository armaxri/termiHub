import { useCallback, useRef } from "react";
import { toast } from "@/components/ui";
import {
  TransferTerminalError,
  dragOutCreateStaging,
  dragOutDiscardStaging,
  dragOutStageSession,
  dragOutStart,
  sessionDownload,
  sessionListFiles,
} from "@/services/api";
import type { FileEntry } from "@/types/connection";
import type { DragOutControl } from "@/components/Sidebar/FileBrowserDndProvider";
import { describeEntries } from "@/utils/fileDragMove";
import {
  DragOutLimitError,
  STAGED_DRAG_OUT_TTL_MS,
  beginDragOut,
  buildStagingTree,
  endDragOut,
  planDragOut,
  runBounded,
  stagedDragOutCache,
  stagedEntryKey,
  type DragOutSource,
} from "@/utils/fileDragOut";
import { errorMessage } from "@/utils/errorMessage";
import { frontendLog } from "@/utils/frontendLog";
import { seedTransferQueueRow } from "./transferFeedback";

/** Discard staged copies whose reuse window has lapsed (best-effort). */
function discardExpiredStaging(): void {
  for (const dir of stagedDragOutCache.takeExpired(Date.now())) {
    dragOutDiscardStaging(dir).catch((err) =>
      frontendLog("file_drag_out", `Could not discard ${dir}: ${errorMessage(err)}`)
    );
  }
}

/** Hand local `paths` to a native OS drag, ending the in-app drag first. */
async function startNativeDrag(paths: string[], control: DragOutControl): Promise<void> {
  control.cancelInAppDrag();
  beginDragOut(paths);
  try {
    const result = await dragOutStart(paths);
    frontendLog("file_drag_out", `Native drag-out of ${paths.length} path(s): ${result}`);
  } catch (err) {
    toast.error(`Drag out failed: ${errorMessage(err)}`);
  } finally {
    endDragOut();
  }
}

/**
 * How many staging downloads run at once. The backend queue bounds its own
 * concurrency too; this keeps a large folder from flooding the queue at once
 * and lets a cancel / failure stop the rest promptly.
 */
export const DRAG_OUT_DOWNLOAD_CONCURRENCY = 4;

/** Remember a finished staging for reuse and schedule its discard. */
function rememberStaging(
  sessionId: string,
  entries: FileEntry[],
  dir: string,
  paths: string[]
): void {
  stagedDragOutCache.add(sessionId, entries, dir, paths, Date.now());
  setTimeout(discardExpiredStaging, STAGED_DRAG_OUT_TTL_MS + 1000);
}

/** Surface a staging failure (quiet on a cancelled transfer). */
function reportStagingFailure(err: unknown, label: string, toastId: string | number): void {
  if (err instanceof TransferTerminalError) {
    // The transfer-progress event path already surfaced it (quiet on cancel).
    toast.dismiss(toastId);
  } else if (err instanceof DragOutLimitError) {
    toast.info(`Can't drag ${label} out: ${err.message}`, { id: toastId });
  } else {
    toast.error(`Preparing ${label} failed: ${errorMessage(err)}`, { id: toastId });
  }
}

/**
 * Download remote `entries` (files, and folders walked recursively) into a
 * fresh private staging directory through the transfer queue (progress /
 * cancel / retry), returning the local copy of each dragged row, or `null` when
 * staging failed or was cancelled (already surfaced to the user).
 */
async function stageRemote(sessionId: string, entries: FileEntry[]): Promise<string[] | null> {
  const label = describeEntries(entries);
  const toastId = toast.loading(`Preparing ${label} to drag out…`);
  let dir: string | null = null;
  try {
    const tree = await buildStagingTree(entries, (path) => sessionListFiles(sessionId, path));
    const staging = await dragOutCreateStaging(tree.staging);
    dir = staging.dir;
    await runBounded(tree.downloads, DRAG_OUT_DOWNLOAD_CONCURRENCY, ({ index, remotePath }) =>
      sessionDownload(sessionId, remotePath, staging.paths[index], (transferId) =>
        seedTransferQueueRow({ transferId, sessionId, direction: "download", remotePath })
      )
    );
    const roots = tree.roots.map((i) => staging.paths[i]);
    rememberStaging(sessionId, entries, staging.dir, roots);
    toast.dismiss(toastId);
    return roots;
  } catch (err) {
    if (dir) {
      dragOutDiscardStaging(dir).catch(() => {});
    }
    reportStagingFailure(err, label, toastId);
    return null;
  }
}

/**
 * Stage byte-based session rows (Docker / remote agent — no transfer queue):
 * the backend reads them through the session into a staging directory it owns
 * (#3491). Returns the local copy of each dragged row, or `null` on failure
 * (already surfaced; the backend discards a failed staging dir itself).
 */
async function stageSessionBytes(
  sessionId: string,
  entries: FileEntry[]
): Promise<string[] | null> {
  const label = describeEntries(entries);
  const toastId = toast.loading(`Preparing ${label} to drag out…`);
  try {
    const staging = await dragOutStageSession(
      sessionId,
      entries.map(({ path, name, isDirectory }) => ({ path, name, isDirectory }))
    );
    rememberStaging(sessionId, entries, staging.dir, staging.paths);
    toast.dismiss(toastId);
    return staging.paths;
  } catch (err) {
    reportStagingFailure(err, label, toastId);
    return null;
  }
}

/**
 * Drag file-browser rows out of the window onto the OS file manager (#3457).
 *
 * Returns the `onDragOut` handler for {@link FileBrowserDndProvider}:
 *
 * - local rows start a native OS file drag of their real paths immediately;
 * - SFTP / FTP rows (files, and folders walked recursively) are downloaded to a
 *   private staging directory through the transfer queue first; Docker / agent
 *   rows are staged by the backend through the session (#3491). If the pointer is still held outside the window when
 *   that finishes, the native drag starts right away; otherwise the user is told
 *   the files are ready, and dragging the same unchanged rows out again within
 *   the reuse window starts the native drag instantly from the staged copies;
 * - a selection beyond the staging limits is refused with a hint to use
 *   Download.
 */
export function useFileDragOut(
  source: DragOutSource
): (entries: FileEntry[], control: DragOutControl) => void {
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const inFlight = useRef(new Set<string>());

  return useCallback((entries: FileEntry[], control: DragOutControl) => {
    const plan = planDragOut(entries, sourceRef.current);
    if (plan.kind === "refuse") {
      toast.info(plan.message);
      return;
    }
    if (plan.kind === "local") {
      void startNativeDrag(plan.paths, control);
      return;
    }
    const { sessionId } = plan;
    discardExpiredStaging();
    const cached = stagedDragOutCache.lookup(sessionId, plan.entries, Date.now());
    if (cached) {
      void startNativeDrag(cached, control);
      return;
    }
    const key = plan.entries.map((e) => stagedEntryKey(sessionId, e)).join("\u0001");
    if (inFlight.current.has(key)) return;
    inFlight.current.add(key);
    const stage = plan.kind === "remote" ? stageRemote : stageSessionBytes;
    void stage(sessionId, plan.entries)
      .then((paths) => {
        if (!paths) return;
        if (control.isStillDragging()) {
          void startNativeDrag(paths, control);
        } else {
          toast.success(
            `${describeEntries(plan.entries)} ready — drag ${plan.entries.length === 1 ? "it" : "them"} out of the window again to save`
          );
        }
      })
      .finally(() => inFlight.current.delete(key));
  }, []);
}
