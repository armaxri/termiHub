/**
 * `useProjectedMonitors` — the status bar & Open Connections cut to the projected
 * `system-monitors` region (#2224 render cut, part of #2139).
 *
 * The status bar renders the active tab's monitor stats/status and Open
 * Connections renders one row per live monitor. Through the shadow step both read
 * `appStore.monitors` / `appStore.monitoringStatsCache` directly. This hook makes
 * them source that slice from the shared `system-monitors` projection region
 * instead — the direct analog of {@link import("./useLayoutRenderTree").useLayoutRenderTree}
 * (#2151) and {@link import("./useSessionLifecycle").useSessionAutoReconnect} (#2204).
 *
 * # Safety (strangler)
 *
 * - **Gated** by {@link monitorRenderFromProjectionEnabled} (on by default). Flag
 *   off ⇒ the hook returns `appStore`'s slice verbatim.
 * - **Faithful-mirror gate.** The projection sources the render only when it
 *   deep-equals the `appStore` slice ({@link monitorsViewMirrors}); otherwise the
 *   hook falls back to `appStore` (never a stale view). While `appStore` stays
 *   authoritative (the mutation cut is a later step) the region is kept a mirror
 *   by {@link seedMonitorsRegion}, so it is always populated — making the cut
 *   parity-safe and independent of the mutation flag.
 */

import { useEffect, useMemo, useState } from "react";

import { useAppStore } from "@/store/appStore";
import {
  currentMonitorsView,
  ensureMonitorsSubscribed,
  logMonitorBridgeFallback,
  monitorRenderFromProjectionEnabled,
  monitorsViewMirrors,
  onMonitorsView,
  seedMonitorsRegion,
  type SystemMonitorsView,
} from "@/store/systemMonitorBridge";

/**
 * The effective monitoring slice for rendering: the `monitors` map + `statsCache`
 * sourced from the projected `system-monitors` region when it faithfully mirrors
 * `appStore`, otherwise `appStore`'s slice verbatim (flag off, region not yet
 * caught up, or a transport that cannot subscribe).
 */
export function useProjectedMonitors(): SystemMonitorsView {
  const monitors = useAppStore((s) => s.monitors);
  const statsCache = useAppStore((s) => s.monitoringStatsCache);

  // Read the flag once at mount: it flips only via dev tooling, and the
  // subscription lifecycle is keyed off it below.
  const [enabled] = useState(() => monitorRenderFromProjectionEnabled());

  const [view, setView] = useState<SystemMonitorsView | undefined>(undefined);

  // Subscribe to the shared system-monitors region while enabled; a transport
  // that cannot subscribe (non-Tauri without a socket) just leaves the UI on the
  // appStore fallback.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const unsubscribe = onMonitorsView((next) => {
      if (!cancelled) setView(next);
    });
    // `ensureMonitorsSubscribed` builds the transport eagerly, so a non-Tauri env
    // without a socket throws synchronously (not just a rejection) — guard both so
    // the UI silently stays on the appStore fallback.
    try {
      ensureMonitorsSubscribed()
        .then(() => {
          if (!cancelled) setView(currentMonitorsView());
        })
        .catch((err) => logMonitorBridgeFallback("subscribe", err));
    } catch (err) {
      logMonitorBridgeFallback("subscribe", err);
    }
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [enabled]);

  const matches = enabled && monitorsViewMirrors(view, monitors, statsCache);

  // Keep the region a faithful mirror of appStore's slice. Only once a view has
  // arrived (so we are subscribed) and it is not already a mirror; de-duped inside
  // `seedMonitorsRegion` so a settled slice is not re-seeded on every render.
  useEffect(() => {
    if (!enabled || matches || view === undefined) return;
    seedMonitorsRegion(monitors, statsCache).catch((err) => logMonitorBridgeFallback("seed", err));
  }, [enabled, matches, view, monitors, statsCache]);

  return useMemo(() => {
    if (matches && view) return view;
    return { monitors, statsCache };
  }, [matches, view, monitors, statsCache]);
}
