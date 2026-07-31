import { StateCreator } from "zustand";

import type { AppState } from "../appStore";
import type { HttpMonitorState } from "@/types/network";

/**
 * HTTP monitors domain slice (extracted under #2077 via #2300): the list of
 * running network HTTP monitors that the Network Tools sidebar keeps in sync
 * as the single source of truth, plus its replace-all setter. Extracted
 * verbatim from the monolithic root store as a behavior-preserving Zustand
 * slice — the setter still receives the shared `set` typed against the full
 * {@link AppState}, so the public store shape and behavior are unchanged. The
 * tab-opening `openNetworkDiagnosticTab` action deliberately stays in the tab
 * domain. Mirrors the SSH tunnel slice (#2077) and the embedded-server /
 * macros / plugins / session-history / zoom / command-palette slices
 * (#2113/#2114/#2115/#2299/#2300).
 */

export interface HttpMonitorsSlice {
  /** Running network HTTP monitors (populated by NetworkToolsSidebar on open). */
  httpMonitors: HttpMonitorState[];
  /** Replace the full list of HTTP monitors. */
  setHttpMonitors: (monitors: HttpMonitorState[]) => void;
}

export const createHttpMonitorsSlice: StateCreator<AppState, [], [], HttpMonitorsSlice> = (
  set
) => ({
  httpMonitors: [],
  setHttpMonitors: (monitors) => set({ httpMonitors: monitors }),
});
