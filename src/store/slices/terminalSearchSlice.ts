import { StateCreator } from "zustand";

import type { AppState } from "../appStore";

/**
 * Terminal-search domain slice (extracted under #2077 via #2300): the
 * runtime-only (never persisted) per-tab visibility of the in-terminal search
 * bar, keyed by tab id, plus the set/toggle actions that drive it. Extracted
 * verbatim from the monolithic root store as a behavior-preserving Zustand
 * slice — every action still receives the shared `set` typed against the full
 * {@link AppState}, so the public store shape and behavior are unchanged. The
 * tab-close reducer in `appStore.ts` still reads and rewrites
 * `terminalSearchVisible` through the combined store, which composes across
 * slices unchanged. Mirrors the SSH tunnel slice (#2077) and the
 * embedded-server / macros / plugins / session-history / zoom / command-palette
 * / http-monitors / dialogs / remote-desktop-resolutions / password-prompt
 * slices (#2113/#2114/#2115/#2299/#2300).
 */

export interface TerminalSearchSlice {
  /**
   * Per-tab visibility of the in-terminal search bar, keyed by tab id
   * (runtime-only, never persisted). Cleared for a tab when it closes.
   */
  terminalSearchVisible: Record<string, boolean>;
  /** Show or hide the search bar for a specific tab. */
  setTerminalSearchVisible: (tabId: string, visible: boolean) => void;
  /** Flip the search-bar visibility for a specific tab. */
  toggleTerminalSearch: (tabId: string) => void;
}

export const createTerminalSearchSlice: StateCreator<AppState, [], [], TerminalSearchSlice> = (
  set
) => ({
  terminalSearchVisible: {},
  setTerminalSearchVisible: (tabId, visible) =>
    set((s) => ({ terminalSearchVisible: { ...s.terminalSearchVisible, [tabId]: visible } })),
  toggleTerminalSearch: (tabId) =>
    set((s) => ({
      terminalSearchVisible: {
        ...s.terminalSearchVisible,
        [tabId]: !s.terminalSearchVisible[tabId],
      },
    })),
});
