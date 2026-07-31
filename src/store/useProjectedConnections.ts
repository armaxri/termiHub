/**
 * `useProjectedConnections` — the connection tree sidebar cut to the projected
 * `connections` region (#2225 render cut, part of #2139 and #2153).
 *
 * The connection tree sidebar renders the saved-connection / folder tree (two flat
 * arrays whose nesting is expressed by parent pointers). Through the shadow step it
 * reads `appStore`'s connections slice (`folders` / `connections`) directly. This
 * hook makes it source that slice from the shared `connections` projection region
 * instead — the direct analog of {@link import("./useProjectedAgents").useProjectedAgents}
 * (#2226) and {@link import("./useProjectedMonitors").useProjectedMonitors} (#2224).
 *
 * # Safety (strangler)
 *
 * - **Gated** by {@link connectionRenderFromProjectionEnabled} (on by default).
 *   Flag off ⇒ the hook returns `appStore`'s slice verbatim.
 * - **Faithful-mirror gate.** The projection sources the render only when it
 *   deep-equals the `appStore` slice ({@link connectionsViewMirrors}); otherwise the
 *   hook falls back to `appStore` (never a stale view). While `appStore` stays
 *   authoritative (the mutation cut is a later step) the region is kept a mirror by
 *   {@link seedConnectionsRegion}, so it is always populated — making the cut
 *   parity-safe and independent of the mutation flag.
 */

import { useEffect, useMemo, useState } from "react";

import { useAppStore } from "@/store/appStore";
import {
  connectionRenderFromProjectionEnabled,
  connectionsViewMirrors,
  currentConnectionsView,
  ensureConnectionsSubscribed,
  logConnectionBridgeFallback,
  onConnectionsView,
  seedConnectionsRegion,
  type ConnectionsView,
} from "@/store/connectionsBridge";

/**
 * The effective connections slice for rendering: the flat `folders` tree plus the
 * flat `connections` list, sourced from the projected `connections` region when it
 * faithfully mirrors `appStore`, otherwise `appStore`'s slice verbatim (flag off,
 * region not yet caught up, or a transport that cannot subscribe).
 */
export function useProjectedConnections(): ConnectionsView {
  const folders = useAppStore((s) => s.folders);
  const connections = useAppStore((s) => s.connections);

  // Read the flag once at mount: it flips only via dev tooling, and the
  // subscription lifecycle is keyed off it below.
  const [enabled] = useState(() => connectionRenderFromProjectionEnabled());

  const [view, setView] = useState<ConnectionsView | undefined>(undefined);

  // Subscribe to the shared connections region while enabled; a transport that
  // cannot subscribe (non-Tauri without a socket) just leaves the UI on the
  // appStore fallback.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const unsubscribe = onConnectionsView((next) => {
      if (!cancelled) setView(next);
    });
    // `ensureConnectionsSubscribed` builds the transport eagerly, so a non-Tauri
    // env without a socket throws synchronously (not just a rejection) — guard both
    // so the UI silently stays on the appStore fallback.
    try {
      ensureConnectionsSubscribed()
        .then(() => {
          if (!cancelled) setView(currentConnectionsView());
        })
        .catch((err) => logConnectionBridgeFallback("subscribe", err));
    } catch (err) {
      logConnectionBridgeFallback("subscribe", err);
    }
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [enabled]);

  const matches = enabled && connectionsViewMirrors(view, folders, connections);

  // Keep the region a faithful mirror of appStore's slice. Only once a view has
  // arrived (so we are subscribed) and it is not already a mirror; de-duped inside
  // `seedConnectionsRegion` so a settled slice is not re-seeded on every render.
  useEffect(() => {
    if (!enabled || matches || view === undefined) return;
    seedConnectionsRegion(folders, connections).catch((err) =>
      logConnectionBridgeFallback("seed", err)
    );
  }, [enabled, matches, view, folders, connections]);

  return useMemo(() => {
    if (matches && view) return view;
    return { folders, connections };
  }, [matches, view, folders, connections]);
}
