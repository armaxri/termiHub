import { useEffect } from "react";
import { useAppStore } from "@/store/appStore";
import { transferList } from "@/services/api";
import { frontendLog } from "@/utils/frontendLog";
import { isTerminalTransferState } from "@/types/transfer";

/**
 * How often to poll `transfer_list` while the queue holds a non-terminal row.
 * An order of magnitude below the backend's terminal-retention window (#1645),
 * so a transfer whose terminal event was dropped is caught well within the
 * window the backend keeps its snapshot around.
 */
const RECONCILE_INTERVAL_MS = 4000;

/**
 * Backstop for a dropped *terminal* `transfer-progress` event (#1645).
 *
 * `useTransferEvents` folds best-effort progress events into the queue; under
 * memory pressure the webview can miss the terminal event, leaving a seeded row
 * (#1632) stuck at `queued`/`active` forever. This hook polls the reliable
 * request/response `transfer_list` snapshot **while any row is non-terminal**
 * and settles a stuck row to its true terminal state (the backend now retains
 * recently-terminal transfers and includes legacy SFTP, #1645).
 *
 * Polling is gated on there being a pending row, so an idle app makes no calls.
 * It also reconciles on window focus (a returning user's transfers settle at
 * once) and stops as soon as every row is terminal.
 */
export function useTransferReconcile(): void {
  const reconcileTransferQueue = useAppStore((s) => s.reconcileTransferQueue);
  // Re-runs the effect only when this boolean flips (Object.is equality), so the
  // poll starts when a transfer begins and stops when the last row settles.
  const hasPending = useAppStore((s) =>
    Object.values(s.transferQueue).some((e) => !isTerminalTransferState(e.state))
  );

  useEffect(() => {
    if (!hasPending) return;

    let cancelled = false;
    const reconcile = async () => {
      try {
        const snapshots = await transferList();
        if (!cancelled) reconcileTransferQueue(snapshots);
      } catch (err) {
        frontendLog("transfer_reconcile", `transfer_list reconcile failed: ${String(err)}`);
      }
    };

    // Reconcile promptly, then on a tick and whenever the window regains focus.
    void reconcile();
    const interval = window.setInterval(() => void reconcile(), RECONCILE_INTERVAL_MS);
    const onFocus = () => void reconcile();
    window.addEventListener("focus", onFocus);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [hasPending, reconcileTransferQueue]);
}
