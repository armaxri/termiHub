import { useEffect } from "react";
import { useAppStore } from "@/store/appStore";
import { onTransferProgress, onSessionOwnershipChanged } from "@/services/events";
import { toast } from "@/components/ui";
import type { TransferProgress } from "@/services/api";

/**
 * Raise the single terminal-phase toast for a settled transfer (#1286).
 *
 * This event path is the **sole owner** of the terminal success/error toast, so
 * a transfer — however it was initiated (file-browser download/upload/paste, or
 * a background transfer that never went through `runTransfer`) — produces
 * exactly one terminal toast. The file-browser `runTransfer` helper only shows a
 * pending toast and dismisses it, deferring the terminal toast here (see
 * `useFileSystem.ts`).
 *
 * - `done`      → `toast.success` ("Downloaded …" / "Uploaded …").
 * - `error`     → recoverable `toast.error` carrying the backend `message`.
 * - `cancelled` → stay quiet: the user initiated the cancel, and the Cancel
 *   button already raises its own "Transfer cancelled" confirmation
 *   (`FileBrowser`/`OpenConnectionsModal`), so toasting the `cancelled` phase
 *   here would double up. The in-flight row simply disappears from the
 *   Transfers UI.
 */
function toastTerminalPhase(progress: TransferProgress): void {
  const { phase, direction, fileName, message } = progress;
  if (phase === "done") {
    const verb = direction === "download" ? "Downloaded" : "Uploaded";
    toast.success(`${verb} ${fileName}`);
  } else if (phase === "error") {
    const verb = direction === "download" ? "Download" : "Upload";
    toast.error(`${verb} of ${fileName} failed: ${message ?? "Transfer failed"}`);
  }
  // `cancelled` and `transferring` intentionally emit no toast.
}

/**
 * Coalesce ownership-map refreshes (#1964). `transfer-progress` events fire once
 * per chunk, so a naive refetch-per-event would spam the IPC bridge; this
 * collapses a burst into at most one refresh per window, keeping
 * {@link useAppStore}'s `sessionOwners` fresh during active transfers (so the
 * fold gate scopes each transfer to its owning window) without flooding the
 * backend. Module-scoped because the timer is a shared imperative resource.
 */
let ownersRefreshTimer: ReturnType<typeof setTimeout> | null = null;
const OWNERS_REFRESH_DEBOUNCE_MS = 150;
function scheduleOwnersRefresh(refresh: () => void): void {
  if (ownersRefreshTimer !== null) return;
  ownersRefreshTimer = setTimeout(() => {
    ownersRefreshTimer = null;
    refresh();
  }, OWNERS_REFRESH_DEBOUNCE_MS);
}

/**
 * Hook that listens for `transfer-progress` events from the backend (#1245) and
 * folds them into the store's transient `transfers` map (#1247), driving the Open
 * Connections "Transfers" section, the file-browser footer, and the status-bar
 * aggregate. On a terminal phase it also raises the one success/error toast for
 * the transfer (#1286).
 *
 * The **Transfer Queue panel** slice is no longer folded here: since #2229 the
 * shared `transfers` projection region is authoritative and the backend folds the
 * same `transfer-progress` stream into it **at the source** (#2387), so the queue
 * rows arrive via the region diff without any client-side fold.
 *
 * It also keeps the backend `session → window` ownership map mirrored in the
 * store fresh (#1964): once on mount, and coalesced while transfers flow. That
 * lets a window learn which of its sibling windows owns a session so a broadcast
 * transfer is folded (into the transient `transfers` map) only in the owning
 * window, even without a tab move.
 */
export function useTransferEvents(): void {
  const applyTransferProgress = useAppStore((s) => s.applyTransferProgress);
  const refreshSessionOwners = useAppStore((s) => s.refreshSessionOwners);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let unlistenOwnership: (() => void) | null = null;

    // Seed the ownership map so scoping is correct from the first event, before
    // any transfer has flowed.
    void refreshSessionOwners();

    const setup = async () => {
      // Push path (#1985): refresh the ownership mirror the moment the backend
      // reports a claim/release/window-destroy, so a sibling window's claim is
      // reflected here immediately — no flash-then-prune waiting on the first
      // transfer-progress event. Debounced (shared coalescer) to avoid a storm
      // during multi-session restore.
      unlistenOwnership = await onSessionOwnershipChanged(() => {
        scheduleOwnersRefresh(() => void refreshSessionOwners());
      });
      unlisten = await onTransferProgress((progress) => {
        // Keep the ownership map fresh while transfers flow (coalesced) so a
        // session claimed by a sibling window is scoped out here (#1964).
        scheduleOwnersRefresh(() => void refreshSessionOwners());
        // Fold the event into the transient #1247 `transfers` map (clears
        // terminal rows) that drives Open Connections / the footer / the status
        // bar. The persistent #1337 Transfer Queue panel is fed server-side into
        // the authoritative `transfers` region (#2229 / #2387) — no fold here.
        applyTransferProgress(progress);
        toastTerminalPhase(progress);
      });
    };

    void setup();

    return () => {
      unlisten?.();
      unlistenOwnership?.();
    };
  }, [applyTransferProgress, refreshSessionOwners]);
}
