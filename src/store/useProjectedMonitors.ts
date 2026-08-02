/**
 * `useProjectedMonitors` — read the authoritative `system-monitors` region
 * (#2224, part of #2139).
 *
 * The status bar renders the active tab's monitor stats/status and Open
 * Connections renders one row per live monitor. Both source that state from the
 * shared `system-monitors` projection region, which is now **authoritative**: the
 * backend `SystemMonitorStore` is fed at the source (#2376) — the collector loop
 * folds every stats sample and status change, and the session monitoring commands
 * fold the lifecycle — so the region is the single source of truth. `appStore` no
 * longer holds any monitor state.
 *
 * The hook subscribes to the region (one shared subscription, fanned out by the
 * bridge) and returns the latest projected view, re-rendering on every diff. It
 * seeds from {@link currentMonitorsView} so a consumer mounting after the first
 * diff already has the current picture. There is no `appStore` fallback and no
 * mirror gate — the region is the source of truth.
 */

import { useEffect, useState } from "react";

import {
  currentMonitorsView,
  ensureMonitorsSubscribed,
  logMonitorBridgeFallback,
  onMonitorsView,
  type SystemMonitorsView,
} from "@/store/systemMonitorBridge";

/**
 * The current monitoring slice for rendering: the `monitors` map + `statsCache`
 * sourced from the authoritative `system-monitors` projection region.
 */
export function useProjectedMonitors(): SystemMonitorsView {
  const [view, setView] = useState<SystemMonitorsView>(() => currentMonitorsView());

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = onMonitorsView((next) => {
      if (!cancelled) setView(next);
    });
    // `ensureMonitorsSubscribed` builds the transport eagerly, so a non-Tauri env
    // without a socket throws synchronously (not just a rejection) — guard both so
    // the hook silently stays on the last-known (or empty) view.
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
  }, []);

  return view;
}
