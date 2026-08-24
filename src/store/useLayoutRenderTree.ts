/**
 * `useLayoutRenderTree` — the renderer's handle on the active tab group's panel
 * tree (#2151, part of #2139; finalized in #2283 slice E2).
 *
 * `SplitView` renders the active group's tree. Since the layout data-flow
 * inversion completed (#2283 slice E2), `appStore.rootPanel` is **no longer an
 * independent authoritative store** — it is composed by the region→appStore
 * mirror from the `layout@<clientId>` projection (structure) plus `appStore`'s
 * by-id tab content. So the renderer simply reads that region-derived tree; the
 * earlier strangler machinery (a runtime flag, a faithful-mirror gate, and a
 * seed-on-drift effect that let the renderer source structure straight from the
 * projection while `appStore` was still authoritative) is gone.
 */

import { useAppStore } from "@/store/appStore";
import type { PanelNode } from "@/types/terminal";

/** The active tab group's panel tree for rendering — the region-derived
 * `appStore.rootPanel` (composed by the layout mirror). */
export function useLayoutRenderTree(): PanelNode {
  return useAppStore((s) => s.rootPanel);
}
