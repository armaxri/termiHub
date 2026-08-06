import { useEffect, useMemo } from "react";
import { transferList } from "@/services/api";
import { frontendLog } from "@/utils/frontendLog";
import { isTerminalTransferState } from "@/types/transfer";
import { dispatchTransferIntentBestEffort } from "@/store/transfersBridge";
import { useProjectedTransfers } from "@/store/useProjectedTransfers";

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
 * The backend folds live `transfer-progress` into the authoritative `transfers`
 * region (#2229 / #2387); under memory pressure the webview can still miss the
 * terminal event, leaving a seeded row (#1632) stuck at `queued`/`active` forever.
 * This hook polls the reliable request/response `transfer_list` snapshot **while
 * any row is non-terminal** and dispatches a `transfer.reconcile` intent that
 * settles a stuck row to its true terminal state in the shared store (the backend
 * now retains recently-terminal transfers and includes legacy SFTP, #1645).
 *
 * Polling is gated on there being a pending row, so an idle app makes no calls.
 * It also reconciles on window focus (a returning user's transfers settle at
 * once) and stops as soon as every row is terminal.
 */
export function useTransferReconcile(): void {
  // Read the queue from the authoritative `transfers` region, then derive the
  // pending flag with `useMemo` so the O(rows) scan runs *only* when the queue
  // actually changes (#1657). The effect below re-runs only when this boolean
  // flips, so the poll starts when a transfer begins and stops when the last row
  // settles.
  const { queue } = useProjectedTransfers();
  const hasPending = useMemo(
    () => Object.values(queue).some((e) => !isTerminalTransferState(e.state)),
    [queue]
  );

  useEffect(() => {
    if (!hasPending) return;

    const reconcile = async () => {
      try {
        const snapshots = await transferList();
        // Reliable client intent against the authoritative store — a bridge
        // hiccup is swallowed and logged, never disrupting the poll loop.
        dispatchTransferIntentBestEffort("transfer.reconcile", { snapshots });
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
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [hasPending]);
}
