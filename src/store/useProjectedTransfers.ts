/**
 * `useProjectedTransfers` — the Transfer Queue panel cut to the projected
 * `transfers` region (#2229 render cut, part of #2139 and #2153).
 *
 * The Transfer Queue panel renders the per-transfer queue map plus the
 * panel-minimized flag. Through the shadow step it reads `appStore`'s
 * transfer-queue slice (`transferQueue` / `transferQueueMinimized`) directly. This
 * hook makes it source that slice from the shared `transfers` projection region
 * instead — the direct analog of {@link import("./useProjectedConnections").useProjectedConnections}
 * (#2225) and {@link import("./useProjectedAgents").useProjectedAgents} (#2226).
 *
 * # Safety (strangler)
 *
 * - **Gated** by {@link transferRenderFromProjectionEnabled} (on by default).
 *   Flag off ⇒ the hook returns `appStore`'s slice verbatim.
 * - **Faithful-mirror gate.** The projection sources the render only when it
 *   deep-equals the `appStore` slice ({@link transfersViewMirrors}); otherwise the
 *   hook falls back to `appStore` (never a stale view). While `appStore` stays
 *   authoritative (the mutation cut is a later step) the region is kept a mirror by
 *   {@link seedTransfersRegion}, so it is always populated — making the cut
 *   parity-safe and independent of the mutation flag.
 */

import { useEffect, useMemo, useState } from "react";

import { useAppStore } from "@/store/appStore";
import {
  currentTransfersView,
  ensureTransfersSubscribed,
  logTransferBridgeFallback,
  onTransfersView,
  seedTransfersRegion,
  transferRenderFromProjectionEnabled,
  transfersViewMirrors,
  type TransfersView,
} from "@/store/transfersBridge";

/**
 * The effective transfers slice for rendering: the per-transfer queue map plus
 * the panel-minimized flag, sourced from the projected `transfers` region when it
 * faithfully mirrors `appStore`, otherwise `appStore`'s slice verbatim (flag off,
 * region not yet caught up, or a transport that cannot subscribe).
 */
export function useProjectedTransfers(): TransfersView {
  const queue = useAppStore((s) => s.transferQueue);
  const minimized = useAppStore((s) => s.transferQueueMinimized);

  // Read the flag once at mount: it flips only via dev tooling, and the
  // subscription lifecycle is keyed off it below.
  const [enabled] = useState(() => transferRenderFromProjectionEnabled());

  const [view, setView] = useState<TransfersView | undefined>(undefined);

  // Subscribe to the shared transfers region while enabled; a transport that
  // cannot subscribe (non-Tauri without a socket) just leaves the UI on the
  // appStore fallback.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const unsubscribe = onTransfersView((next) => {
      if (!cancelled) setView(next);
    });
    // `ensureTransfersSubscribed` builds the transport eagerly, so a non-Tauri
    // env without a socket throws synchronously (not just a rejection) — guard both
    // so the UI silently stays on the appStore fallback.
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
  }, [enabled]);

  const matches = enabled && transfersViewMirrors(view, queue, minimized);

  // Keep the region a faithful mirror of appStore's slice. Only once a view has
  // arrived (so we are subscribed) and it is not already a mirror; de-duped inside
  // `seedTransfersRegion` so a settled slice is not re-seeded on every render.
  useEffect(() => {
    if (!enabled || matches || view === undefined) return;
    seedTransfersRegion(queue, minimized).catch((err) => logTransferBridgeFallback("seed", err));
  }, [enabled, matches, view, queue, minimized]);

  return useMemo(() => {
    if (matches && view) return view;
    return { queue, minimized };
  }, [matches, view, queue, minimized]);
}
