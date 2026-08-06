/**
 * `useProjectedConnections` — read the authoritative `connections` region (#2225,
 * part of #2139 and #2153).
 *
 * The connection tree sidebar ({@link import("../components/Sidebar/ConnectionList").ConnectionList})
 * renders the saved-connection / folder inventory (two flat arrays whose nesting is
 * expressed by parent pointers). It sources that inventory from the shared
 * `connections` projection region, which is now **authoritative**: the backend
 * `ConnectionsStore` is fed at the source — every persisted saved-connection /
 * folder mutation and the external-file overlay are folded server-side (#2389 and
 * #2394) — so the region is the single source of truth. `appStore` still holds a
 * connections slice for the other, not-yet-migrated readers (the wider
 * reader-migration + reducer removal is a later step), but the sidebar no longer
 * reads it.
 *
 * The hook subscribes to the region (one shared subscription, fanned out by the
 * bridge) and returns the latest projected view, re-rendering on every diff. It
 * seeds from {@link currentConnectionsView} so a consumer mounting after the first
 * diff already has the current picture. There is no `appStore` fallback and no
 * mirror gate — the region is the source of truth.
 */

import { useEffect, useState } from "react";

import {
  currentConnectionsView,
  ensureConnectionsSubscribed,
  logConnectionBridgeFallback,
  onConnectionsView,
  type ConnectionsView,
} from "@/store/connectionsBridge";

/**
 * The current connections slice for rendering: the flat `folders` tree plus the
 * flat `connections` list, sourced from the authoritative `connections` projection
 * region.
 */
export function useProjectedConnections(): ConnectionsView {
  const [view, setView] = useState<ConnectionsView>(() => currentConnectionsView());

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = onConnectionsView((next) => {
      if (!cancelled) setView(next);
    });
    // `ensureConnectionsSubscribed` builds the transport eagerly, so a non-Tauri
    // env without a socket throws synchronously (not just a rejection) — guard
    // both so the hook silently stays on the last-known (or empty) view.
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
  }, []);

  return view;
}
