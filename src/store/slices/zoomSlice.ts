import { StateCreator } from "zustand";

import type { AppState } from "../appStore";

/**
 * Webview zoom domain slice (extracted under #2077 via #2300): the runtime-only
 * (never persisted) webview scale factor plus the in/out/reset actions that
 * drive it. Extracted verbatim from the monolithic root store as a
 * behavior-preserving Zustand slice — every action still receives the shared
 * `set`/`get` typed against the full {@link AppState}, so the public store shape
 * and behavior are unchanged. Mirrors the SSH tunnel slice (#2077) and the
 * embedded-server / macros / plugins / session-history slices
 * (#2113/#2114/#2115/#2299).
 */

export interface ZoomSlice {
  /** Runtime-only webview scale factor (1.0 = 100%), not persisted. */
  zoomLevel: number;
  /** Increase the webview zoom by 10%, capped at 3.0. */
  zoomIn: () => void;
  /** Decrease the webview zoom by ~10%, floored at 0.5. */
  zoomOut: () => void;
  /** Reset the webview zoom back to 1.0. */
  zoomReset: () => void;
}

export const createZoomSlice: StateCreator<AppState, [], [], ZoomSlice> = (set) => ({
  zoomLevel: 1.0,
  zoomIn: () =>
    set((s) => ({ zoomLevel: Math.min(parseFloat((s.zoomLevel * 1.1).toFixed(2)), 3.0) })),
  zoomOut: () =>
    set((s) => ({ zoomLevel: Math.max(parseFloat((s.zoomLevel / 1.1).toFixed(2)), 0.5) })),
  zoomReset: () => set({ zoomLevel: 1.0 }),
});
