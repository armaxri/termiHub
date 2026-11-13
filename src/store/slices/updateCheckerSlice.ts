import { StateCreator } from "zustand";

import type { AppState } from "../appStore";
import type { UpdateInfo } from "@/types/connection";
import {
  checkForUpdates as apiCheckForUpdates,
  skipUpdateVersion as apiSkipUpdateVersion,
  clearSkippedVersion as apiClearSkippedVersion,
  downloadAppUpdate as apiDownloadAppUpdate,
  installAppUpdateAndRestart as apiInstallAppUpdateAndRestart,
} from "@/services/api";
import { onAppUpdateDownloadProgress } from "@/services/events";
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
/** Where an in-app update install stands (#5758). */
export type AppUpdateInstallPhase = "idle" | "downloading" | "ready" | "restarting";

/** In-app update install state: phase plus download progress in bytes. */
export interface AppUpdateInstallState {
  phase: AppUpdateInstallPhase;
  /** The version being downloaded / ready to install, or `null` when idle. */
  version: string | null;
  downloaded: number;
  /** Total bytes, when the server sent a size. */
  total: number | null;
}

const IDLE_INSTALL: AppUpdateInstallState = {
  phase: "idle",
  version: null,
  downloaded: 0,
  total: null,
};

export interface UpdateCheckerSlice {
  // Update checker
  updateCheckState: "idle" | "checking" | "up-to-date" | "available" | "error";
  updateInfo: UpdateInfo | null;
  /** Why the last check failed (backend `failureReason`), or `null`. */
  updateCheckFailureReason: string | null;
  updateNotificationDismissed: boolean;
  checkForUpdates: (force: boolean) => Promise<void>;
  dismissUpdateNotification: () => void;
  skipUpdate: () => Promise<void>;
  clearSkippedUpdateVersion: () => Promise<void>;
  /** In-app update install state (#5758). */
  appUpdateInstall: AppUpdateInstallState;
  /**
   * Download and verify the available update in the background (#5758). Only
   * for an update whose `installMethod` is `inApp`; rejects with the reason
   * when the download or its signature check fails. Installs nothing.
   */
  downloadAppUpdate: () => Promise<void>;
  /** Install the downloaded update and restart termiHub (#5758). */
  restartToInstallUpdate: () => Promise<void>;
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
  updateCheckFailureReason: null,
  updateNotificationDismissed: false,
  appUpdateInstall: IDLE_INSTALL,
  checkForUpdates: async (force: boolean) => {
    const previousState = get().updateCheckState;
    set({ updateCheckState: "checking" });
    try {
      const info = await apiCheckForUpdates(force);
      // The backend states what the check did (#5651); the page never infers
      // it from which fields are filled in.
      switch (info.outcome) {
        case "notChecking":
          // A build that does not check: keep the result so the page can say so.
          set({ updateCheckState: "up-to-date", updateInfo: info, updateCheckFailureReason: null });
          return;
        case "skippedAutoOff":
        case "skippedRateLimited":
          // No feed was read (#5615): that is not a check, so it must never
          // turn into "Up to date" — keep whatever the last real check said.
          set({ updateCheckState: previousState === "checking" ? "idle" : previousState });
          return;
        case "failed": {
          // Manual or automatic, a failed check shows as failed (#5651).
          const reason = info.failureReason ?? "unknown error";
          set({ updateCheckState: "error", updateCheckFailureReason: reason });
          frontendLog("update", `Update check failed: ${reason}`);
          // The backend stamps lastCheckTime even on failure.
          await refreshLastCheckTime();
          return;
        }
        case "upToDate":
        case "updateAvailable":
          break;
      }
      if (info.outcome === "updateAvailable") {
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
          updateCheckFailureReason: null,
        });
      } else {
        set({ updateCheckState: "up-to-date", updateInfo: info, updateCheckFailureReason: null });
      }
      // After the skip fold above read the current settings view.
      await refreshLastCheckTime();
    } catch (err) {
      const reason = errorMessage(err);
      set({ updateCheckState: "error", updateCheckFailureReason: reason });
      frontendLog("update", `Update check failed: ${reason}`);
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
  downloadAppUpdate: async () => {
    const info = get().updateInfo;
    if (!info?.available || info.installMethod !== "inApp") {
      throw new Error("No in-app update is available for this install.");
    }
    const version = info.latestVersion;
    set({ appUpdateInstall: { ...IDLE_INSTALL, phase: "downloading", version } });
    const unlisten = await onAppUpdateDownloadProgress(({ downloaded, total }) => {
      if (get().appUpdateInstall.phase !== "downloading") return;
      set({ appUpdateInstall: { phase: "downloading", version, downloaded, total } });
    });
    try {
      await apiDownloadAppUpdate(version);
    } catch (err) {
      set({ appUpdateInstall: IDLE_INSTALL });
      frontendLog("update", `In-app update download failed: ${errorMessage(err)}`);
      throw err;
    } finally {
      unlisten();
    }
    set({ appUpdateInstall: { ...get().appUpdateInstall, phase: "ready", version } });
  },
  restartToInstallUpdate: async () => {
    if (get().appUpdateInstall.phase !== "ready") {
      throw new Error("No downloaded update to install.");
    }
    set({ appUpdateInstall: { ...get().appUpdateInstall, phase: "restarting" } });
    try {
      // On success the app exits and restarts on the new version.
      await apiInstallAppUpdateAndRestart();
    } catch (err) {
      // The backend consumed the download; start over from a fresh download.
      set({ appUpdateInstall: IDLE_INSTALL });
      frontendLog("update", `In-app update install failed: ${errorMessage(err)}`);
      throw err;
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
