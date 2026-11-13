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
import { errorMessage } from "@/utils/errorMessage";

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

/**
 * Whether the backend actually read a release feed for this result. Every
 * feed-backed result carries the release page URL; the backend's feed-less
 * "no update" placeholder (rate limit, auto-check off, feed error, or a build
 * that does not check) leaves it empty.
 */
function consultedFeed(info: UpdateInfo): boolean {
  return info.available || info.releaseUrl !== "";
}

/**
 * The backend persists `updates.lastCheckTime` after a real check but does not
 * push it into the settings region, so pull the refreshed document in — else
 * the page keeps reading "Last checked: Never" after a check (#5615).
 */
async function refreshLastCheckTime(): Promise<void> {
  try {
    const updatedSettings = await getSettings();
    mirrorSettingsIntent("settings.replace", { settings: updatedSettings });
  } catch (err) {
    frontendLog("update", `Failed to refresh the last check time: ${errorMessage(err)}`);
  }
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
    const previousState = get().updateCheckState;
    set({ updateCheckState: "checking" });
    try {
      const info = await apiCheckForUpdates(force);
      if (!consultedFeed(info)) {
        // No release feed was read (#5615): auto-check off, rate-limited, a
        // build that does not check, or a swallowed feed error. That is not
        // a check, so it must never turn into "Up to date".
        if (info.channel === "none") {
          set({ updateCheckState: "up-to-date", updateInfo: info });
        } else if (force) {
          set({ updateCheckState: "error" });
          frontendLog("update", "Update check did not reach the release feed");
        } else {
          set({ updateCheckState: previousState === "checking" ? "idle" : previousState });
        }
        return;
      }
      await refreshLastCheckTime();
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
      frontendLog("update", `Failed to skip version: ${errorMessage(err)}`);
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
      frontendLog("update", `Failed to clear skipped version: ${errorMessage(err)}`);
    }
  },
});
