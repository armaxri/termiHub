/**
 * `useProjectedBroadcast` — the broadcast UI cut to the projected
 * `broadcast@<clientId>` region (#2242 render cut, part of #2206 / #2139).
 *
 * The status-bar pill, tab badges, panel ring/glow, and toolbar toggle render the
 * broadcast membership. Through the shadow step they read `appStore`'s broadcast
 * slice directly. This hook makes them source that slice from the client-scoped
 * `broadcast` projection region instead — the direct analog of
 * {@link import("./useProjectedMonitors").useProjectedMonitors} (#2224) and
 * {@link import("./useLayoutRenderTree").useLayoutRenderTree} (#2151).
 *
 * # Safety (strangler)
 *
 * - **Gated** by {@link broadcastRenderFromProjectionEnabled} (on by default). Flag
 *   off ⇒ the hook returns `appStore`'s slice verbatim.
 * - **Faithful-mirror gate.** The projection sources the render only when it mirrors
 *   the `appStore` slice ({@link broadcastViewMirrors}); otherwise the hook falls
 *   back to `appStore` (never a stale view). While `appStore` stays authoritative
 *   the region is kept a mirror by {@link seedBroadcastRegion}, so it is always
 *   populated — making the cut parity-safe and independent of the mutation flag.
 *
 * The connected-terminal fan-out filter (`getBroadcastTargetTabIds`), the scope→tabs
 * resolution, and the membership recompute stay on `appStore` — they need the live
 * tab tree — so consumers keep calling those store methods; only the membership
 * *state* (`active` / `sourceTabId` / `scope` / `targetTabIds` / `lastScope`) is
 * sourced here.
 */

import { useEffect, useMemo, useState } from "react";

import {
  broadcastRenderFromProjectionEnabled,
  broadcastViewMirrors,
  currentBroadcastView,
  ensureBroadcastSubscribed,
  logBroadcastBridgeFallback,
  onBroadcastView,
  seedBroadcastRegion,
  type BroadcastSlice,
  type BroadcastView,
} from "@/store/broadcastBridge";
import { useAppStore } from "@/store/appStore";

/**
 * The effective broadcast membership slice for rendering: sourced from the
 * projected `broadcast` region when it faithfully mirrors `appStore`, otherwise
 * `appStore`'s slice verbatim (flag off, region not yet caught up, or a transport
 * that cannot subscribe). `targetTabIds` is a `Set<string>`, so the return value is
 * a drop-in for the previous direct `appStore` reads.
 */
export function useProjectedBroadcast(): BroadcastSlice {
  const active = useAppStore((s) => s.broadcastActive);
  const sourceTabId = useAppStore((s) => s.broadcastSourceTabId);
  const scope = useAppStore((s) => s.broadcastScope);
  const targetTabIds = useAppStore((s) => s.broadcastTargetTabIds);
  const lastScope = useAppStore((s) => s.lastBroadcastScope);

  const slice: BroadcastSlice = useMemo(
    () => ({ active, sourceTabId, scope, targetTabIds, lastScope }),
    [active, sourceTabId, scope, targetTabIds, lastScope]
  );

  // Read the flag once at mount: it flips only via dev tooling, and the
  // subscription lifecycle is keyed off it below.
  const [enabled] = useState(() => broadcastRenderFromProjectionEnabled());

  const [view, setView] = useState<BroadcastView | undefined>(undefined);

  // Subscribe to the client-scoped broadcast region while enabled; a transport that
  // cannot subscribe (non-Tauri without a socket) just leaves the UI on the appStore
  // fallback.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const unsubscribe = onBroadcastView((next) => {
      if (!cancelled) setView(next);
    });
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
  }, [enabled]);

  const matches = enabled && broadcastViewMirrors(view, slice);

  // Keep the region a faithful mirror of appStore's slice. Only once a view has
  // arrived (so we are subscribed) and it is not already a mirror; de-duped inside
  // `seedBroadcastRegion` so a settled slice is not re-seeded on every render.
  useEffect(() => {
    if (!enabled || matches || view === undefined) return;
    seedBroadcastRegion({
      active,
      sourceTabId,
      scope,
      targetTabIds: [...targetTabIds],
      lastScope,
    }).catch((err) => logBroadcastBridgeFallback("seed", err));
  }, [enabled, matches, view, active, sourceTabId, scope, targetTabIds, lastScope]);

  return useMemo(() => {
    if (matches && view) {
      return {
        active: view.active,
        sourceTabId: view.sourceTabId,
        scope: view.scope,
        targetTabIds: new Set(view.targetTabIds),
        lastScope: view.lastScope,
      };
    }
    return slice;
  }, [matches, view, slice]);
}
