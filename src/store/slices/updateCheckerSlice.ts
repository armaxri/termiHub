import { StateCreator } from "zustand";

import type { AppState } from "../appStore";
import type { UpdateInfo } from "@/types/connection";
import {
  checkForUpdates as apiCheckForUpdates,
  skipUpdateVersion as apiSkipUpdateVersion,
  clearSkippedVersion as apiClearSkippedVersion,
} from "@/services/api";
import { currentSettingsView, mirrorSettingsIntent } from "../settingsBridge";
import { getSettings } from "@/services/storage";
import { frontendLog } from "@/utils/frontendLog";

/**
 * Update-checker domain slice (ARCH-001/FES-011, appStore god-module split via
 * #2881): the app-update availability probe plus the skip/dismiss lifecycle —
 * the current check state, the last {@link UpdateInfo}, the notification-dismissed
 * flag, and the actions that drive them. `checkForUpdates` folds a previously
 * skipped (non-security) version into the dismissed flag by reading the
 * authoritative `settings` projection; `skipUpdate` / `clearSkippedUpdateVersion`
 * are thin command wrappers that persist through the backend and reflect the
 * refreshed settings document into the region (#2404) — the persisted
 * `skippedVersion` lives in the settings region, not in `appStore`. Extracted
 * verbatim from the monolithic root store as a behavior-preserving Zustand slice —
 * every action still receives the shared `set`/`get` typed against the full
 * {@link AppState}, so the public store shape and behavior are unchanged. Mirrors
 * the credential-store / SSH tunnel / password-prompt / etc. slices.
 */
export interface UpdateCheckerSlice {
  // Update checker
  updateCheckState: "idle" | "checking" | "up-to-date" | "available" | "error";
  updateInfo: UpdateInfo | null;
  updateNotificationDismissed: boolean;
  checkForUpdates: (force: boolean) => Promise<void>;
  dismissUpdateNotification: () => void;
  skipUpdate: () => Promise<void>;
  clearSkippedUpdateVersion: () => Promise<void>;
}

export const createUpdateCheckerSlice: StateCreator<AppState, [], [], UpdateCheckerSlice> = (
  set,
  get
) => ({
  // Update checker
  updateCheckState: "idle",
  updateInfo: null,
  updateNotificationDismissed: false,
  checkForUpdates: async (force: boolean) => {
    set({ updateCheckState: "checking" });
    try {
      const info = await apiCheckForUpdates(force);
      if (info.available) {
        const currentSettings = currentSettingsView();
        const skippedVersion = currentSettings.updates?.skippedVersion;
        // If the update is available but the user previously skipped this exact
        // version (and it's not a security patch), keep the dot visible but don't
        // reset the dismissed flag so no popup re-appears.
        const isSkipped = !info.isSecurity && skippedVersion === info.latestVersion;
        set({
          updateCheckState: "available",
          updateInfo: info,
          // Reset dismissed flag so the popup shows for newly detected versions,
          // unless the user already skipped this version.
          updateNotificationDismissed: isSkipped,
        });
      } else {
        set({ updateCheckState: "up-to-date", updateInfo: info });
      }
    } catch {
      set({ updateCheckState: "error" });
      frontendLog("update", "Update check failed");
    }
  },
  dismissUpdateNotification: () => set({ updateNotificationDismissed: true }),
  skipUpdate: async () => {
    const { updateInfo } = get();
    if (!updateInfo) return;
    try {
      await apiSkipUpdateVersion(updateInfo.latestVersion);
      // Refresh the persisted settings so skippedVersion is current, then reflect
      // it into the authoritative region (#2404) — no `appStore` slice to set.
      const updatedSettings = await getSettings();
      set({ updateNotificationDismissed: true });
      mirrorSettingsIntent("settings.replace", { settings: updatedSettings });
    } catch (err) {
      frontendLog("update", `Failed to skip version: ${err}`);
    }
  },
  clearSkippedUpdateVersion: async () => {
    try {
      await apiClearSkippedVersion();
      const updatedSettings = await getSettings();
      // Reflect the refreshed persisted document into the authoritative region
      // (#2404) — no `appStore` slice to set.
      mirrorSettingsIntent("settings.replace", { settings: updatedSettings });
    } catch (err) {
      frontendLog("update", `Failed to clear skipped version: ${err}`);
    }
  },
});
