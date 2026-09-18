import { StateCreator } from "zustand";

import type { AppState } from "../appStore";
import { getAppMode as apiGetAppMode } from "@/services/api";
import { frontendLog } from "@/utils/frontendLog";
import { errorMessage } from "@/utils/errorMessage";

/**
 * Portable-mode domain slice (ARCH-001/FES-011, appStore god-module split via
 * #2881): whether the app is running in portable mode (launched from a directory
 * containing a `data/` folder — see `src-tauri/src/utils/portable.rs`) and, if so,
 * the resolved portable data directory, plus the one action that probes the
 * backend for it. `loadAppMode` reads the {@link AppModeInfo} snapshot from the
 * backend and reflects it into the region; the status bar's portable badge and the
 * portable-mode settings panel read `isPortableMode` / `portableDataDir` from here.
 * Extracted verbatim from the monolithic root store as a behavior-preserving
 * Zustand slice — every action still receives the shared `set`/`get` typed against
 * the full {@link AppState}, so the public store shape and behavior are unchanged.
 * Mirrors the update-checker / credential-store / SSH tunnel / etc. slices.
 */
export interface PortableModeSlice {
  // Portable mode
  isPortableMode: boolean;
  portableDataDir: string | null;
  loadAppMode: () => Promise<void>;
}

export const createPortableModeSlice: StateCreator<AppState, [], [], PortableModeSlice> = (
  set
) => ({
  // Portable mode
  isPortableMode: false,
  portableDataDir: null,
  loadAppMode: async () => {
    try {
      const info = await apiGetAppMode();
      set({ isPortableMode: info.isPortable, portableDataDir: info.dataDir });
    } catch (err) {
      frontendLog("app_store", `Failed to load app mode: ${errorMessage(err)}`);
    }
  },
});
