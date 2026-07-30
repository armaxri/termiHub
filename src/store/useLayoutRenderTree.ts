/**
 * `useLayoutRenderTree` — the renderer's cut to the projected layout render-list
 * (#2151 step 3, part of #2139).
 *
 * `SplitView` renders the active tab group's panel tree. Through step 2 that
 * tree came straight from `appStore.rootPanel` (a mirror the mutation bridge
 * reconciled from the `layout@<clientId>` projection). Step 3 makes the
 * **renderer** source its structure from the projection directly and overlay
 * per-tab content from `appStore` — the partial-projection seam (Decision #2:
 * the layout region carries only panel structure + minimal tab identity; title,
 * colour, session status, broadcast and zoom stay in `appStore`).
 *
 * The hook returns a rich {@link PanelNode} — structure from the projection,
 * content re-attached by tab id from `appStore`'s current tree — so `SplitView`
 * consumes it exactly where it used to read `appStore.rootPanel` (one call
 * site). Because the composed tree preserves every `tab.id`/`panel.id`, the live
 * xterm DOM is reparented, never remounted (see {@link composeRenderTree}).
 *
 * # Safety (strangler)
 *
 * - **Gated** by {@link layoutIntentsEnabled}. Flag off → the hook returns
 *   `appStore.rootPanel` verbatim, so the renderer is byte-for-byte unchanged.
 * - **Faithful-mirror gate.** The projection drives the render only when its
 *   view is a structural mirror of `appStore`'s tree ({@link viewMatchesTree}).
 *   Tab create/close/reorder/activate are not yet layout intents, so they edit
 *   `appStore` locally and momentarily desync the region; while desynced the
 *   hook falls back to `appStore.rootPanel` (never a stale tree) and
 *   {@link seedLayoutRegion} catches the region up so composing resumes. The
 *   gate guarantees the composed tree is structurally identical to
 *   `appStore.rootPanel`, so rendering can never diverge from the pre-cut output.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { useAppStore } from "@/store/appStore";
import {
  composeRenderTree,
  ensureLayoutRegionClient,
  type LayoutView,
  layoutRenderFromProjectionEnabled,
  logRenderFallback,
  type MinimalNode,
  minimalNodesEqual,
  seedLayoutRegion,
  toMinimalNode,
  viewMatchesTree,
} from "@/store/layoutBridge";
import type { ProjectionCacheState, ProjectionClient } from "@/services/transport";
import type { PanelNode } from "@/types/terminal";

/**
 * The active tab group's panel tree for rendering: structure sourced from the
 * projected layout region when it faithfully mirrors `appStore`, otherwise
 * `appStore.rootPanel` verbatim (flag off, region not yet caught up, or a
 * transport that cannot subscribe).
 */
export function useLayoutRenderTree(): PanelNode {
  const storeRoot = useAppStore((s) => s.rootPanel);
  const storeActivePanelId = useAppStore((s) => s.activePanelId);

  // Read the flag once at mount: it flips only via dev tooling, and the
  // subscription lifecycle is keyed off it below.
  const [enabled] = useState(() => layoutRenderFromProjectionEnabled());

  const [regionState, setRegionState] = useState<ProjectionCacheState | null>(null);
  const clientRef = useRef<ProjectionClient | null>(null);
  const lastSeeded = useRef<{ root: MinimalNode; activePanelId: string | null } | null>(null);

  // Subscribe to the layout region while enabled; a transport that cannot
  // subscribe (non-Tauri without a socket) just leaves the renderer on the
  // appStore fallback.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let unsubscribe = (): void => {};
    ensureLayoutRegionClient()
      .then((client) => {
        if (cancelled) return;
        clientRef.current = client;
        setRegionState(client.state);
        unsubscribe = client.onChange((state) => setRegionState(state));
      })
      .catch((err) => logRenderFallback(err));
    return () => {
      cancelled = true;
      unsubscribe();
      clientRef.current = null;
    };
  }, [enabled]);

  const view = regionState?.view as LayoutView | undefined;
  const matches = enabled && viewMatchesTree(view, storeRoot, storeActivePanelId);

  // Keep the region a faithful mirror of appStore's structure. When the view is
  // not a mirror (initial single-leaf snapshot, or a local non-intent edit),
  // seed it with the current tree so composing can resume. De-duped so a settled
  // tree is not reseeded on every render.
  useEffect(() => {
    if (!enabled || !clientRef.current || matches) return;
    const minimal = toMinimalNode(storeRoot);
    const prev = lastSeeded.current;
    if (
      prev &&
      prev.activePanelId === storeActivePanelId &&
      minimalNodesEqual(prev.root, minimal)
    ) {
      return;
    }
    lastSeeded.current = { root: minimal, activePanelId: storeActivePanelId };
    seedLayoutRegion(storeRoot, storeActivePanelId).catch((err) => logRenderFallback(err));
    // `regionState` is a dep so the seed re-evaluates once the region snapshot
    // first arrives (which sets `clientRef` but may leave `matches` false).
  }, [enabled, matches, storeRoot, storeActivePanelId, regionState]);

  return useMemo(() => {
    if (matches && view) {
      try {
        return composeRenderTree(view, storeRoot);
      } catch (err) {
        // A tab referenced by the view but absent from appStore — treat as a
        // desync and fall back rather than throw in render.
        logRenderFallback(err);
        return storeRoot;
      }
    }
    return storeRoot;
  }, [matches, view, storeRoot]);
}
