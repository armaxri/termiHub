import { useCallback, useRef } from "react";
import { toast } from "@/components/ui";
import {
  TransferTerminalError,
  dragOutCreateStaging,
  dragOutDiscardStaging,
  dragOutStart,
  sessionDownload,
} from "@/services/api";
import type { FileEntry } from "@/types/connection";
import type { DragOutControl } from "@/components/Sidebar/FileBrowserDndProvider";
import { describeEntries } from "@/utils/fileDragMove";
import {
  STAGED_DRAG_OUT_TTL_MS,
  beginDragOut,
  endDragOut,
  planDragOut,
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
 * Download remote `entries` into a fresh private staging directory through the
 * transfer queue (progress / cancel / retry), returning the local copies, or
 * `null` when staging failed or was cancelled (already surfaced to the user).
 */
async function stageRemote(sessionId: string, entries: FileEntry[]): Promise<string[] | null> {
  const label = describeEntries(entries);
  const toastId = toast.loading(`Preparing ${label} to drag out…`);
  let dir: string | null = null;
  try {
    const staging = await dragOutCreateStaging(entries.map((e) => e.name));
    dir = staging.dir;
    // Let every download settle before judging, so a failed leg never has its
    // staging dir discarded under a sibling that is still writing into it.
    const results = await Promise.allSettled(
      entries.map((entry, i) =>
        sessionDownload(sessionId, entry.path, staging.paths[i], (transferId) =>
          seedTransferQueueRow({
            transferId,
            sessionId,
            direction: "download",
            remotePath: entry.path,
          })
        )
      )
    );
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) throw failed.reason;
    stagedDragOutCache.add(sessionId, entries, staging.dir, staging.paths, Date.now());
    setTimeout(discardExpiredStaging, STAGED_DRAG_OUT_TTL_MS + 1000);
    toast.dismiss(toastId);
    return staging.paths;
  } catch (err) {
    if (dir) {
      dragOutDiscardStaging(dir).catch(() => {});
    }
    if (err instanceof TransferTerminalError) {
      // The transfer-progress event path already surfaced it (quiet on cancel).
      toast.dismiss(toastId);
    } else {
      toast.error(`Preparing ${label} failed: ${errorMessage(err)}`, { id: toastId });
    }
    return null;
  }
}

/**
 * Drag file-browser rows out of the window onto the OS file manager (#3457).
 *
 * Returns the `onDragOut` handler for {@link FileBrowserDndProvider}:
 *
 * - local rows start a native OS file drag of their real paths immediately;
 * - SFTP / FTP rows are downloaded to a private staging directory through the
 *   transfer queue first. If the pointer is still held outside the window when
 *   that finishes, the native drag starts right away; otherwise the user is told
 *   the files are ready, and dragging the same unchanged rows out again within
 *   the reuse window starts the native drag instantly from the staged copies;
 * - remote folders and byte-based sessions are refused with a hint to use
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
    void stageRemote(sessionId, plan.entries)
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
