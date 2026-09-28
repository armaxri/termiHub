import { StateCreator } from "zustand";

import { omitKey, type AppState } from "../appStore";
import type { TerminalOptions } from "@/types/terminal";

/**
 * Per-tab runtime state slice (ARCH-001/FES-011, appStore god-module split via
 * #2881): the runtime-only per-tab maps keyed by tab id — the tracked working
 * directory (`tabCwds`), horizontal scrolling, per-connection terminal options and
 * tab color — plus their setters.
 *
 * Extracted verbatim from the monolithic root store as a behavior-preserving
 * Zustand slice — every setter still receives the shared `set` typed against the
 * full {@link AppState}, so the public store shape and behavior are unchanged. The
 * tab-open seeding of these maps and their close-tab cleanup stay in the root store
 * (tabs/layout domain), as does `renameTab`, which patches the layout-owned
 * `tabContent` map (#2562).
 */
export interface TabRuntimeSlice {
  // Per-tab CWD tracking
  tabCwds: Record<string, string>;
  setTabCwd: (tabId: string, cwd: string) => void;

  // Per-tab horizontal scrolling
  tabHorizontalScrolling: Record<string, boolean>;
  setTabHorizontalScrolling: (tabId: string, enabled: boolean) => void;

  // Per-tab terminal options (per-connection overrides)
  tabTerminalOptions: Record<string, TerminalOptions>;

  // Per-tab color
  tabColors: Record<string, string>;
  setTabColor: (tabId: string, color: string | null) => void;
}

export const createTabRuntimeSlice: StateCreator<AppState, [], [], TabRuntimeSlice> = (set) => ({
  // Per-tab CWD tracking
  tabCwds: {},
  setTabCwd: (tabId, cwd) => set((state) => ({ tabCwds: { ...state.tabCwds, [tabId]: cwd } })),

  // Per-tab horizontal scrolling
  tabHorizontalScrolling: {},
  setTabHorizontalScrolling: (tabId, enabled) =>
    set((state) => ({
      tabHorizontalScrolling: { ...state.tabHorizontalScrolling, [tabId]: enabled },
    })),

  // Per-tab terminal options
  tabTerminalOptions: {},

  // Per-tab color
  tabColors: {},
  setTabColor: (tabId, color) =>
    set((state) => ({
      tabColors:
        color === null ? omitKey(state.tabColors, tabId) : { ...state.tabColors, [tabId]: color },
    })),
});
