import { StateCreator } from "zustand";

import type { AppState } from "../appStore";
import { getComposedLayout } from "../layoutHelpers";
import { getAllLeaves } from "@/utils/panelTree";

/**
 * Panel zoom overlay slice (ARCH-001/FES-011, appStore god-module split via
 * #2881): the runtime-only (never persisted) `zoomedTabId` that temporarily
 * expands the active terminal tab to full view, plus its setter and the
 * active-tab toggle. Distinct from the webview scale factor in ZoomSlice.
 *
 * Extracted verbatim from the monolithic root store as a behavior-preserving
 * Zustand slice — every action still receives the shared `set`/`get` typed
 * against the full {@link AppState}, so the public store shape and behavior are
 * unchanged. The toggle only *reads* the composed layout; the zoom-follow writes
 * of `zoomedTabId` inside the tab/panel actions (move, close, activate, focus
 * panel) stay in the root store because they are part of those layout
 * transitions and their `layoutCoupledRollback` (#3256).
 */
export interface PanelZoomSlice {
  /** The tab currently expanded by the zoom overlay, or `null` when none is. */
  zoomedTabId: string | null;
  setZoomedTabId: (tabId: string | null) => void;
  /** Toggle zoom for the active terminal tab. Zooms in if nothing is zoomed; dismisses otherwise. */
  toggleZoomActiveTab: () => void;
}

export const createPanelZoomSlice: StateCreator<AppState, [], [], PanelZoomSlice> = (set, get) => ({
  zoomedTabId: null,
  setZoomedTabId: (tabId) => set({ zoomedTabId: tabId }),
  toggleZoomActiveTab: () => {
    const { zoomedTabId } = get();
    const { activePanelId, rootPanel } = getComposedLayout(get());
    if (zoomedTabId !== null) {
      set({ zoomedTabId: null });
      return;
    }
    const leaves = getAllLeaves(rootPanel);
    const panel = leaves.find((p) => p.id === activePanelId) ?? leaves[0];
    if (panel?.activeTabId) {
      set({ zoomedTabId: panel.activeTabId });
    }
  },
});
