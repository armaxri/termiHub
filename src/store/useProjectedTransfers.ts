/**
 * `useProjectedTransfers` — read the authoritative `transfers` region (#2229,
 * part of #2139 and #2153).
 *
 * The Transfer Queue panel and its status-bar indicator render the per-transfer
 * queue map plus the panel-minimized flag. Both source that state from the shared
 * `transfers` projection region, which is now **authoritative**: the backend
 * `TransferStore` is fed at the source (#2387) — the SFTP copy loop and the FTP
 * scheduler executor's `transfer-progress` stream is folded server-side, covering
 * the whole register → queue → progress → pause → resume → finish → cancel
 * lifecycle — so the region is the single source of truth. `appStore` no longer
 * holds any transfer-queue state.
 *
 * The hook subscribes to the region (one shared subscription, fanned out by the
 * bridge) and returns the latest projected view, re-rendering on every diff. It
 * seeds from {@link currentTransfersView} so a consumer mounting after the first
 * diff already has the current picture. There is no `appStore` fallback and no
 * mirror gate — the region is the source of truth.
 */

import { useEffect, useState } from "react";

import {
  currentTransfersView,
  ensureTransfersSubscribed,
  logTransferBridgeFallback,
  onTransfersView,
  type TransfersView,
} from "@/store/transfersBridge";

/**
 * The current transfers slice for rendering: the per-transfer queue map plus the
 * panel-minimized flag, sourced from the authoritative `transfers` projection
 * region.
 */
export function useProjectedTransfers(): TransfersView {
  const [view, setView] = useState<TransfersView>(() => currentTransfersView());

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = onTransfersView((next) => {
      if (!cancelled) setView(next);
    });
    // `ensureTransfersSubscribed` builds the transport eagerly, so a non-Tauri
    // env without a socket throws synchronously (not just a rejection) — guard
    // both so the hook silently stays on the last-known (or empty) view.
    try {
      ensureTransfersSubscribed()
        .then(() => {
          if (!cancelled) setView(currentTransfersView());
        })
        .catch((err) => logTransferBridgeFallback("subscribe", err));
    } catch (err) {
      logTransferBridgeFallback("subscribe", err);
    }
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return view;
}
