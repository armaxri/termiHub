import { StateCreator } from "zustand";

import { getActiveTab, type AppState } from "../appStore";
import type {
  AppSettings,
  ShellIntegrationSettings,
  ShellIntegrationStatus,
} from "@/types/connection";
import { saveSettings as persistSettings } from "@/services/storage";
import { saveShellIntegrationSettings } from "@/services/api";
import { applyEffectiveTheme } from "@/services/workspaceSettings";
import { currentSettingsView, mirrorSettingsIntent } from "@/store/settingsBridge";
import { frontendLog } from "@/utils/frontendLog";
import { readConfigBoolean } from "@/utils/connectionConfigFields";
import { errorMessage } from "@/utils/errorMessage";
import { toast } from "@/components/ui";

/**
 * Settings domain slice (ARCH-001/FES-011, appStore god-module split via #2881):
 * the two settings setters, `updateSettings` and `updateShellIntegration`. The
 * persisted `AppSettings` document is region-authoritative (#2404) — it lives only
 * in the shared `settings` projection region, read via `useProjectedSettings()` /
 * `currentSettingsView()` — so this slice holds no state: both actions are thin
 * command wrappers that persist through the backend and dispatch the optimistic
 * `settings.*` intent, relying on the server-side fold (#2386 / #2407).
 * `updateSettings` also drives the cross-domain side effects of a settings change
 * (theme re-apply, monitoring disconnect, files-view fallback, frontend-plugin
 * reconcile) through the shared `get()` / `set`. Extracted verbatim from the
 * monolithic root store as a behavior-preserving Zustand slice — every action
 * still receives the shared `set`/`get` typed against the full {@link AppState},
 * so the public store shape and behavior are unchanged. Mirrors the
 * update-checker / credential-store / monitoring / etc. slices.
 */
export interface SettingsSlice {
  updateSettings: (settings: AppSettings) => Promise<void>;
  /**
   * Persist edited shell-integration settings through the dedicated
   * `save_shell_integration_settings` command. Optimistically patches `nextSi`
   * into the authoritative `settings` region (a `settings.patch`), then on backend
   * failure rolls the region back to the previously-projected shell-integration
   * value and re-throws so the caller can surface the error. Resolves with the
   * refreshed {@link ShellIntegrationStatus} reporting the recomputed
   * registration / staleness state.
   */
  updateShellIntegration: (nextSi: ShellIntegrationSettings) => Promise<ShellIntegrationStatus>;
}

export const createSettingsSlice: StateCreator<AppState, [], [], SettingsSlice> = (set, get) => ({
  updateSettings: async (newSettings) => {
    try {
      // The settings document is region-authoritative (#2404): read the
      // previous document from the projection to drive the side-effect diffs.
      const oldSettings = currentSettingsView();
      await persistSettings(newSettings);
      // Optimistic whole-document write into the authoritative region. The
      // persist above folds `save_settings` into the region server-side (#2386);
      // this dispatch reflects it client-side instantly, and `useProjectedSettings`
      // renders it back. There is no `appStore` slice to set any more.
      mirrorSettingsIntent("settings.replace", { settings: newSettings });

      // Re-apply when the selection changes or when the active custom theme's
      // colors were edited (the customThemes array reference changes on save).
      if (
        oldSettings.theme !== newSettings.theme ||
        oldSettings.customThemes !== newSettings.customThemes
      ) {
        applyEffectiveTheme(newSettings);
      }

      // Side-effects when global defaults are toggled off.
      // Only disconnect if the active tab doesn't have an explicit override.
      if (oldSettings.powerMonitoringEnabled && !newSettings.powerMonitoringEnabled) {
        const activeTab = getActiveTab(get());
        const hasOverride = readConfigBoolean(activeTab?.config, "enableMonitoring") === true;
        if (!hasOverride) {
          get().disconnectMonitoring();
        }
      }
      if (oldSettings.fileBrowserEnabled && !newSettings.fileBrowserEnabled) {
        const activeTab = getActiveTab(get());
        const hasOverride = readConfigBoolean(activeTab?.config, "enableFileBrowser") === true;
        if (!hasOverride) {
          if (get().sidebarView === "files") {
            set({ sidebarView: "connections" });
          }
        }
      }
      // Toggling the experimental frontend-plugin gate (#2048) reconciles the
      // injected plugin scripts: enabling loads active frontend plugins,
      // disabling tears them down. Pass the known-new gate value straight into
      // loadPlugins rather than let it read the eventually-consistent region
      // (#2630): the `settings.replace` above is fire-and-forget, so a re-read
      // of `currentSettingsView()` can still return the stale pre-toggle value
      // and skip the teardown, leaving the widget mounted after a live disable.
      const nextGate = newSettings.frontendPluginsEnabled ?? false;
      if ((oldSettings.frontendPluginsEnabled ?? false) !== nextGate) {
        void get().loadPlugins(nextGate);
      }
    } catch (err) {
      frontendLog("app_store", `Failed to save settings: ${errorMessage(err)}`);
      toast.error(`Failed to save settings: ${errorMessage(err)}`, { id: "save-settings-error" });
    }
  },

  updateShellIntegration: async (nextSi) => {
    // Capture the previously-projected value for rollback. The shell-integration
    // write is a targeted field patch, so dispatch it as a `settings.patch`
    // (shallow-merge) rather than a whole-document replace — keeping a concurrent
    // general-settings edit intact. The backend `settings.patch` route reads the
    // partial from a `{ patch }` envelope (settings_projection/projection.rs), so
    // wrap the field there. This is the optimistic write into the authoritative
    // region (#2404); the persist below also folds server-side (#2407).
    const prevSi = currentSettingsView().shellIntegration;
    mirrorSettingsIntent("settings.patch", { patch: { shellIntegration: nextSi } });
    try {
      return await saveShellIntegrationSettings(nextSi);
    } catch (err) {
      // Roll the region back to the previously-projected shell-integration value.
      mirrorSettingsIntent("settings.patch", { patch: { shellIntegration: prevSi } });
      throw err;
    }
  },
});
