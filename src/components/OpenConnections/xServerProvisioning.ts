import type { UnlistenFn } from "@tauri-apps/api/event";
import { xServerEnsure } from "@/services/api";
import { onXServerProgress } from "@/services/events";
import { isXServerError, type XServerError, type XServerStatusReport } from "@/types/xserver";
import type { XServerProgress } from "@/types/xserver";

/** Callbacks invoked by {@link driveXServerEnsure} as provisioning advances. */
export interface XServerEnsureHandlers {
  /** A progress event for the live bar. */
  onProgress: (progress: XServerProgress) => void;
  /** Provisioning succeeded with the final status report. */
  onSuccess: (report: XServerStatusReport) => void;
  /** Provisioning failed; `error` is the typed failure when one was surfaced. */
  onFailure: (error: XServerError | null, raw: unknown) => void;
}

/**
 * Run the frontend-driven X server provisioning path: subscribe to
 * `x-server-progress` for the live bar, call `x_server_ensure`, and route the
 * outcome to {@link XServerEnsureHandlers}. Shared by the manual setup dialog
 * and the connect-triggered dialog's retry/install recovery (#1296).
 *
 * Returns a cleanup that unsubscribes and suppresses any late callbacks, so an
 * unmount or a phase change mid-provision never updates a stale component.
 */
export function driveXServerEnsure(handlers: XServerEnsureHandlers): () => void {
  let cancelled = false;
  let unlisten: UnlistenFn | undefined;

  void (async () => {
    unlisten = await onXServerProgress((p) => {
      if (!cancelled) handlers.onProgress(p);
    });
    try {
      const report = await xServerEnsure();
      if (!cancelled) handlers.onSuccess(report);
    } catch (e) {
      if (!cancelled) handlers.onFailure(isXServerError(e) ? e : null, e);
    }
  })();

  return () => {
    cancelled = true;
    unlisten?.();
  };
}
