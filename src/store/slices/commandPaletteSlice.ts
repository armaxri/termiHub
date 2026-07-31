import { StateCreator } from "zustand";

import type { AppState } from "../appStore";

/**
 * Command palette / overlay-views domain slice (extracted under #2077 via
 * #2300): the runtime-only (never persisted) open/closed flags for the
 * keyboard-shortcuts overlay, the Cmd/Ctrl+P command palette, and the
 * standalone overlay views (updates / about), plus the setters that drive them.
 * Extracted verbatim from the monolithic root store as a behavior-preserving
 * Zustand slice — every action still receives the shared `set`/`get` typed
 * against the full {@link AppState}, so the public store shape and behavior are
 * unchanged. Mirrors the SSH tunnel slice (#2077) and the embedded-server /
 * macros / plugins / session-history / zoom slices
 * (#2113/#2114/#2115/#2299/#2300).
 */

export interface CommandPaletteSlice {
  /** Whether the keyboard-shortcuts overlay is open (runtime-only). */
  shortcutsOverlayOpen: boolean;
  /** Open or close the keyboard-shortcuts overlay. */
  setShortcutsOverlayOpen: (open: boolean) => void;

  /** Whether the Cmd/Ctrl+P command palette is open (runtime-only). */
  commandPaletteOpen: boolean;
  /** Open or close the command palette. */
  setCommandPaletteOpen: (open: boolean) => void;

  /** The active standalone overlay view (updates / about), or null when none. */
  overlayView: "updates" | "about" | null;
  /** Open a standalone overlay view. */
  openOverlayView: (view: "updates" | "about") => void;
  /** Close the active standalone overlay view. */
  closeOverlayView: () => void;
}

export const createCommandPaletteSlice: StateCreator<AppState, [], [], CommandPaletteSlice> = (
  set
) => ({
  shortcutsOverlayOpen: false,
  setShortcutsOverlayOpen: (open) => set({ shortcutsOverlayOpen: open }),

  commandPaletteOpen: false,
  setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),

  overlayView: null,
  openOverlayView: (view) => set({ overlayView: view }),
  closeOverlayView: () => set({ overlayView: null }),
});
