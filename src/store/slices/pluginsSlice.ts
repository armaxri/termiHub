import { StateCreator } from "zustand";

import { toast } from "@/components/ui";
import { reconcileFrontendPlugins } from "@/plugins/frontendPlugins";
import {
  listPlugins as apiListPlugins,
  installPlugin as apiInstallPlugin,
  uninstallPlugin as apiUninstallPlugin,
  enablePlugin as apiEnablePlugin,
  disablePlugin as apiDisablePlugin,
  getPluginSettings as apiGetPluginSettings,
  updatePluginSettings as apiUpdatePluginSettings,
  readPluginFile,
} from "@/services/api";
import { currentSettingsView } from "@/store/settingsBridge";
import { applyTheme, loadPluginThemes, setRegisteredPluginThemes } from "@/themes";
import type { ThemeDefinition } from "@/themes";
import type { InstalledPlugin, JsonValue, PluginBackendType } from "@/types/plugin";
import { frontendLog } from "@/utils/frontendLog";

import type { AppState } from "../appStore";

/**
 * Project the connection-type selector's plugin-backend entries from the
 * installed-plugin list (#1993): every *active* plugin that declares a
 * `terminalBackend` extension contributes one entry. Disabled/error/incompatible
 * plugins register no backend.
 */
function derivePluginBackendTypes(plugins: InstalledPlugin[]): PluginBackendType[] {
  const result: PluginBackendType[] = [];
  for (const plugin of plugins) {
    const backend = plugin.manifest.extensions.terminalBackend;
    if (plugin.state === "active" && backend) {
      result.push({
        pluginId: plugin.manifest.id,
        connectionType: backend.connectionType,
        displayName: backend.displayName,
      });
    }
  }
  return result;
}

/**
 * Read, validate, and collect the color themes contributed by every *active*
 * theme plugin (#1996). Each plugin's declared `themes/*.json` files are loaded
 * via {@link readPluginFile} and validated against the theme engine's schema;
 * an individual bad theme is logged and skipped rather than blocking the rest.
 * Disabled/error/incompatible plugins contribute nothing. The result is both
 * mirrored into store state (for the selector) and pushed into the theme
 * engine's registry so `plugin:` settings resolve.
 */
async function loadActivePluginThemes(plugins: InstalledPlugin[]): Promise<ThemeDefinition[]> {
  const all: ThemeDefinition[] = [];
  for (const plugin of plugins) {
    const theme = plugin.manifest.extensions.theme;
    if (plugin.state !== "active" || !theme || theme.themes.length === 0) continue;
    const { themes, errors } = await loadPluginThemes(
      plugin.manifest.id,
      theme.themes,
      readPluginFile,
      { pluginName: plugin.manifest.name }
    );
    for (const err of errors) {
      frontendLog(
        "app_store",
        `Skipped plugin theme ${err.pluginId}:${err.themeId} (${err.file}): ${err.message}`
      );
    }
    all.push(...themes);
  }
  return all;
}

/**
 * Plugins domain slice (#2115): the installed-plugin list, the backend-type and
 * theme registries derived from it (#1993/#1996), the frontend-plugin
 * reconciliation (#1998, gated by the experimental opt-in #2048), and the
 * install/enable/disable/settings actions that drive them. Extracted verbatim
 * from the monolithic root store as a behavior-preserving Zustand slice — every
 * action still receives the shared `set`/`get` typed against the full
 * {@link AppState}, so the public store shape and behavior are unchanged.
 * Mirrors the SSH tunnel slice (#2077).
 *
 * Note: `selectPlugin` is intentionally NOT part of this slice — it opens the
 * plugin-detail tab via the root store's `createTab` factory and moves with the
 * panel/tab slice when that domain is extracted (same caveat as
 * `openTunnelEditorTab`). It still writes {@link selectedPluginId}, which lives
 * here.
 */
export interface PluginsSlice {
  /** Installed plugins with their current install/runtime state. */
  plugins: InstalledPlugin[];
  /**
   * Terminal-backend connection types contributed by active plugins, projected
   * from {@link plugins} for the connection-type selector. Derived by
   * {@link loadPlugins}; not set directly.
   */
  pluginBackendTypes: PluginBackendType[];
  /**
   * Color themes contributed by active theme plugins (#1996), for the theme
   * selector's "Plugins" group. Loaded and validated by {@link loadPlugins} and
   * mirrored into the theme engine's registry so `plugin:` settings resolve; not
   * set directly.
   */
  pluginThemes: ThemeDefinition[];
  /** Load the installed-plugin list from the backend and refresh derived state. */
  loadPlugins: () => Promise<void>;
  /**
   * Install a `.termihub-plugin` package from `filePath`, then refresh the list.
   * Surfaces a pending → success/error toast; rejects on failure.
   */
  installPlugin: (
    filePath: string,
    acceptUntrusted: boolean,
    trustPublisher: boolean
  ) => Promise<void>;
  /** Uninstall a plugin by id, then refresh the list. Toasts feedback; rejects on failure. */
  uninstallPlugin: (pluginId: string) => Promise<void>;
  /** Enable (activate) a plugin by id, then refresh the list. Toasts feedback; rejects on failure. */
  enablePlugin: (pluginId: string) => Promise<void>;
  /** Disable a plugin by id, then refresh the list. Toasts feedback; rejects on failure. */
  disablePlugin: (pluginId: string) => Promise<void>;
  /**
   * Read a plugin's stored settings (#2000). Resolves to the persisted key→value
   * object (empty when unset); rejects (logging) on failure so the caller can
   * fall back to schema defaults.
   */
  getPluginSettings: (pluginId: string) => Promise<Record<string, JsonValue>>;
  /**
   * Persist a plugin's settings (#2000). Toasts a recoverable error and rejects
   * on failure; resolves silently on success (the settings section shows its own
   * inline "Saved" acknowledgment).
   */
  updatePluginSettings: (pluginId: string, settings: Record<string, JsonValue>) => Promise<void>;
  /**
   * The manifest id of the plugin currently selected in the Plugins sidebar
   * (#1997), or `null` when none is selected. Drives the sidebar row highlight.
   */
  selectedPluginId: string | null;
}

export const createPluginsSlice: StateCreator<AppState, [], [], PluginsSlice> = (set, get) => ({
  plugins: [],
  pluginBackendTypes: [],
  pluginThemes: [],

  loadPlugins: async () => {
    try {
      const plugins = await apiListPlugins();
      // Load plugin-provided themes (#1996) and register them into the theme
      // engine before publishing state, so a `plugin:` theme selection can
      // resolve as soon as the selector renders it.
      const pluginThemes = await loadActivePluginThemes(plugins);
      setRegisteredPluginThemes(pluginThemes);
      set({ plugins, pluginBackendTypes: derivePluginBackendTypes(plugins), pluginThemes });
      // Load/unload frontend JS plugins — protocol parsers + status-bar
      // widgets (#1998). Reconciles the sandbox against the active set: each
      // plugin's entry point is `importScripts`-ed from the `plugin://` origin,
      // so a load failure now surfaces as a `loadError` inside the worker (#2266)
      // rather than here. Frontend-plugin execution is gated behind the
      // experimental opt-in (#2048): when it is off, reconcile loads nothing and
      // unloads anything already loaded.
      const frontendEnabled = currentSettingsView().frontendPluginsEnabled ?? false;
      reconcileFrontendPlugins(plugins, frontendEnabled);
      // Re-apply the active theme: a just-registered plugin theme now takes
      // effect, and a theme whose plugin was disabled/uninstalled falls back
      // to the default (concept edge case).
      const { theme, customThemes } = currentSettingsView();
      applyTheme(theme, customThemes);
    } catch (err) {
      // Read-only refresh: log rather than toast, matching loadMacros.
      frontendLog(
        "app_store",
        `Failed to load plugins: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  },

  installPlugin: async (filePath, acceptUntrusted, trustPublisher) => {
    const toastId = toast.loading("Installing plugin…");
    try {
      const installed = await apiInstallPlugin(filePath, acceptUntrusted, trustPublisher);
      await get().loadPlugins();
      toast.success(`Installed ${installed.manifest.name}`, { id: toastId });
    } catch (err) {
      toast.error(`Failed to install plugin: ${err instanceof Error ? err.message : String(err)}`, {
        id: toastId,
      });
      throw err;
    }
  },

  uninstallPlugin: async (pluginId) => {
    const name = get().plugins.find((p) => p.manifest.id === pluginId)?.manifest.name ?? pluginId;
    const toastId = toast.loading(`Uninstalling ${name}…`);
    try {
      await apiUninstallPlugin(pluginId);
      await get().loadPlugins();
      toast.success(`Uninstalled ${name}`, { id: toastId });
    } catch (err) {
      toast.error(
        `Failed to uninstall ${name}: ${err instanceof Error ? err.message : String(err)}`,
        {
          id: toastId,
        }
      );
      throw err;
    }
  },

  enablePlugin: async (pluginId) => {
    const name = get().plugins.find((p) => p.manifest.id === pluginId)?.manifest.name ?? pluginId;
    const toastId = toast.loading(`Enabling ${name}…`);
    try {
      await apiEnablePlugin(pluginId);
      await get().loadPlugins();
      toast.success(`Enabled ${name}`, { id: toastId });
    } catch (err) {
      toast.error(`Failed to enable ${name}: ${err instanceof Error ? err.message : String(err)}`, {
        id: toastId,
      });
      throw err;
    }
  },

  disablePlugin: async (pluginId) => {
    const name = get().plugins.find((p) => p.manifest.id === pluginId)?.manifest.name ?? pluginId;
    const toastId = toast.loading(`Disabling ${name}…`);
    try {
      await apiDisablePlugin(pluginId);
      await get().loadPlugins();
      toast.success(`Disabled ${name}`, { id: toastId });
    } catch (err) {
      toast.error(
        `Failed to disable ${name}: ${err instanceof Error ? err.message : String(err)}`,
        {
          id: toastId,
        }
      );
      throw err;
    }
  },

  getPluginSettings: async (pluginId) => {
    try {
      return await apiGetPluginSettings(pluginId);
    } catch (err) {
      // Read-only fetch: log rather than toast; the caller falls back to
      // schema defaults so the form still renders.
      frontendLog(
        "app_store",
        `Failed to load settings for plugin ${pluginId}: ${err instanceof Error ? err.message : String(err)}`
      );
      throw err;
    }
  },

  updatePluginSettings: async (pluginId, settings) => {
    const name = get().plugins.find((p) => p.manifest.id === pluginId)?.manifest.name ?? pluginId;
    try {
      await apiUpdatePluginSettings(pluginId, settings);
    } catch (err) {
      toast.error(
        `Failed to save ${name} settings: ${err instanceof Error ? err.message : String(err)}`
      );
      throw err;
    }
  },

  selectedPluginId: null,
});
