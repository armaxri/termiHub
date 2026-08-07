/**
 * `useProjectedBroadcast` — read the authoritative `broadcast@<clientId>` region
 * (#2206, part of #2139).
 *
 * The status-bar pill, tab badges, panel ring/glow, and toolbar toggle render the
 * broadcast membership. They source that state from the client-scoped `broadcast`
 * projection region, which is now **authoritative**: the backend `BroadcastStore`
 * is driven entirely by the client `broadcast.*` intents (broadcast has no server
 * data source), so the region is the single source of truth. `appStore` no longer
 * holds any broadcast state.
 *
 * The hook subscribes to the region (one shared subscription, fanned out by the
 * bridge) and returns the latest projected view, re-rendering on every diff. It
 * seeds from {@link currentBroadcastView} so a consumer mounting after the first
 * diff already has the current picture. There is no `appStore` fallback and no
 * mirror gate — the region is the source of truth. The direct analog of
 * {@link import("./useProjectedMonitors").useProjectedMonitors} (#2224) and
 * {@link import("./useProjectedTransfers").useProjectedTransfers} (#2229).
 *
 * The connected-terminal fan-out filter (`getBroadcastTargetTabIds`), the scope→tabs
 * resolution, and the membership recompute stay on `appStore` — they need the live
 * tab tree — so consumers keep calling those store methods; only the membership
 * *state* (`active` / `sourceTabId` / `scope` / `targetTabIds` / `lastScope`) is
 * sourced here. `targetTabIds` is returned as a `Set`, a drop-in for the previous
 * direct `appStore` reads.
 */

import { useEffect, useMemo, useState } from "react";

import {
  currentBroadcastView,
  ensureBroadcastSubscribed,
  logBroadcastBridgeFallback,
  onBroadcastView,
  type BroadcastSlice,
  type BroadcastView,
} from "@/store/broadcastBridge";

/** The current broadcast membership slice, sourced from the authoritative region. */
export function useProjectedBroadcast(): BroadcastSlice {
  const [view, setView] = useState<BroadcastView>(() => currentBroadcastView());

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = onBroadcastView((next) => {
      if (!cancelled) setView(next);
    });
    // `ensureBroadcastSubscribed` builds the transport eagerly, so a non-Tauri env
    // without a socket throws synchronously (not just a rejection) — guard both so
    // the hook silently stays on the last-known (or empty) view.
    try {
      ensureBroadcastSubscribed()
        .then(() => {
          if (!cancelled) setView(currentBroadcastView());
        })
        .catch((err) => logBroadcastBridgeFallback("subscribe", err));
    } catch (err) {
      logBroadcastBridgeFallback("subscribe", err);
    }
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return useMemo(
    () => ({
      active: view.active,
      sourceTabId: view.sourceTabId,
      scope: view.scope,
      targetTabIds: new Set(view.targetTabIds),
      lastScope: view.lastScope,
    }),
    [view]
  );
}
