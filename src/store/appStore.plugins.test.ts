/**
 * Tests for the plugin Zustand slice (#1993).
 *
 * Pins that the store's plugin actions round-trip through the plugin Tauri
 * command wrappers in `@/services/api`: loadPlugins populates state and derives
 * the backend-type projection, the mutating actions refresh via loadPlugins and
 * surface pending → success/error toasts, and a failing command rethrows without
 * silently desyncing state.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Toast hub — assert feedback without real DOM toasts. Declared via vi.hoisted
// so the (hoisted) vi.mock factory can reference them at init time.
const { toastSuccess, toastError, toastLoading, loadPluginInSandbox, unloadPluginFromSandbox } =
  vi.hoisted(() => ({
    toastSuccess: vi.fn(),
    toastError: vi.fn(),
    toastLoading: vi.fn(() => "toast-id"),
    // Mock the sandbox host so the frontend-plugin reconcile is observable without
    // spinning up a real Web Worker (#2266).
    loadPluginInSandbox: vi.fn(),
    unloadPluginFromSandbox: vi.fn(),
  }));
vi.mock("@/plugins/sandbox/pluginSandboxHost", () => ({
  loadPluginInSandbox,
  unloadPluginFromSandbox,
}));
vi.mock("@/components/ui", () => ({
  toast: {
    success: toastSuccess,
    error: toastError,
    loading: toastLoading,
    info: vi.fn(),
    dismiss: vi.fn(),
  },
}));

vi.mock("@/services/storage", () => ({
  loadConnections: vi.fn(() =>
    Promise.resolve({ connections: [], folders: [], agents: [], externalErrors: [] })
  ),
  persistConnection: vi.fn(() => Promise.resolve()),
  removeConnection: vi.fn(() => Promise.resolve()),
  persistFolder: vi.fn(() => Promise.resolve()),
  removeFolder: vi.fn(() => Promise.resolve()),
  getSettings: vi.fn(() =>
    Promise.resolve({
      version: "1",
      externalConnectionFiles: [],
      powerMonitoringEnabled: true,
      fileBrowserEnabled: true,
    })
  ),
  saveSettings: vi.fn(() => Promise.resolve()),
  moveConnectionToFile: vi.fn(() => Promise.resolve()),
  reloadExternalConnections: vi.fn(() => Promise.resolve([])),
  getRecoveryWarnings: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
  loadPluginThemes: vi.fn(() => Promise.resolve({ themes: [], errors: [] })),
  setRegisteredPluginThemes: vi.fn(),
}));

vi.mock("@/services/api", () => ({
  // Baseline stubs the store binds at import.
  sftpOpen: vi.fn(),
  sftpClose: vi.fn(() => Promise.resolve()),
  sftpListDir: vi.fn(),
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
  // Plugin command wrappers under test.
  listPlugins: vi.fn(() => Promise.resolve([])),
  installPlugin: vi.fn(),
  uninstallPlugin: vi.fn(() => Promise.resolve()),
  enablePlugin: vi.fn(() => Promise.resolve()),
  disablePlugin: vi.fn(() => Promise.resolve()),
  getPluginSettings: vi.fn(() => Promise.resolve({})),
  updatePluginSettings: vi.fn(() => Promise.resolve()),
  readPluginFile: vi.fn(() => Promise.resolve(new Uint8Array())),
}));

import { useAppStore } from "./appStore";
import { layoutState } from "@/test/layoutState";
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
import { loadPluginThemes, setRegisteredPluginThemes } from "@/themes";
import { darkTheme } from "@/themes/dark";
import type { ThemeDefinition } from "@/themes";
import type { InstalledPlugin, PluginState } from "@/types/plugin";
import { resetLoadedFrontendPlugins } from "@/plugins/frontendPlugins";
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";

setupSettingsRegion();

/** A plugin declaring a frontend (JS) extension — a protocol parser entry point. */
function frontendPlugin(id: string, state: PluginState = "active"): InstalledPlugin {
  return {
    manifest: {
      id,
      name: `Plugin ${id}`,
      version: "1.0.0",
      author: "tester",
      description: "a frontend plugin",
      license: "MIT",
      apiVersion: "1.0",
      platforms: ["linux"],
      permissions: ["ui"],
      extensions: {
        protocolParser: { name: id, description: "d", entryPoint: "frontend/index.js" },
      },
    },
    state,
    installedAt: "2026-07-26T00:00:00Z",
  };
}

function makePlugin(
  id: string,
  state: PluginState,
  overrides: { connectionType?: string; withBackend?: boolean } = {}
): InstalledPlugin {
  const withBackend = overrides.withBackend ?? true;
  return {
    manifest: {
      id,
      name: `Plugin ${id}`,
      version: "1.0.0",
      author: "tester",
      description: "a test plugin",
      license: "MIT",
      apiVersion: "1.0",
      platforms: ["linux"],
      permissions: ["terminal"],
      extensions: withBackend
        ? {
            terminalBackend: {
              connectionType: overrides.connectionType ?? id,
              displayName: `Backend ${id}`,
              configSchema: {},
            },
          }
        : { theme: { themes: [{ id: "t", name: "T", file: "t.json" }] } },
    },
    state,
    installedAt: "2026-07-26T00:00:00Z",
  };
}

describe("appStore — plugins (#1993)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
  });

  it("starts with empty plugin state", () => {
    expect(useAppStore.getState().plugins).toEqual([]);
    expect(useAppStore.getState().pluginBackendTypes).toEqual([]);
    // Not loaded yet: an empty list means "unknown", not "none installed" (#3344).
    expect(useAppStore.getState().pluginsLoaded).toBe(false);
  });

  it("loadPlugins populates the list and derives backend types from active plugins only", async () => {
    vi.mocked(apiListPlugins).mockResolvedValueOnce([
      makePlugin("active-be", "active"),
      makePlugin("disabled-be", "disabled"),
      makePlugin("theme-only", "active", { withBackend: false }),
    ]);

    await useAppStore.getState().loadPlugins();

    const state = layoutState();
    expect(state.plugins).toHaveLength(3);
    expect(state.pluginsLoaded).toBe(true);
    // Only the active plugin that declares a terminalBackend is projected.
    expect(state.pluginBackendTypes).toEqual([
      { pluginId: "active-be", connectionType: "active-be", displayName: "Backend active-be" },
    ]);
  });

  it("loadPlugins loads plugin themes and registers them into the theme engine (#1996)", async () => {
    const themePlugin = makePlugin("themer", "active", { withBackend: false });
    vi.mocked(apiListPlugins).mockResolvedValueOnce([themePlugin]);
    const registered: ThemeDefinition = {
      id: "plugin:themer:t",
      name: "T",
      colorScheme: "dark",
      colors: darkTheme.colors,
    };
    vi.mocked(loadPluginThemes).mockResolvedValueOnce({ themes: [registered], errors: [] });

    await useAppStore.getState().loadPlugins();

    // The active theme plugin's declared themes are passed to the loader…
    expect(loadPluginThemes).toHaveBeenCalledWith(
      "themer",
      [{ id: "t", name: "T", file: "t.json" }],
      readPluginFile,
      { pluginName: "Plugin themer" }
    );
    // …mirrored into store state for the selector…
    expect(useAppStore.getState().pluginThemes).toEqual([registered]);
    // …and pushed into the engine registry so `plugin:` settings resolve.
    expect(setRegisteredPluginThemes).toHaveBeenCalledWith([registered]);
  });

  it("loadPlugins swallows errors and leaves state untouched", async () => {
    vi.mocked(apiListPlugins).mockRejectedValueOnce(new Error("backend down"));
    await expect(useAppStore.getState().loadPlugins()).resolves.toBeUndefined();
    expect(useAppStore.getState().plugins).toEqual([]);
  });

  // Frontend-plugin execution is gated behind the experimental opt-in (#2048):
  // loadPlugins must read `settings.frontendPluginsEnabled` and only load plugin
  // JS into the sandbox when it is on.
  it("loadPlugins does not execute frontend plugins while the experimental gate is off (#2048)", async () => {
    vi.mocked(apiListPlugins).mockResolvedValueOnce([frontendPlugin("fe")]);

    // Default settings leave frontendPluginsEnabled unset (off).
    await useAppStore.getState().loadPlugins();

    expect(loadPluginInSandbox).not.toHaveBeenCalled();
    resetLoadedFrontendPlugins();
  });

  it("loadPlugins executes frontend plugins once the experimental gate is on (#2048)", async () => {
    vi.mocked(apiListPlugins).mockResolvedValueOnce([frontendPlugin("fe")]);
    seedSettings({ frontendPluginsEnabled: true });

    await useAppStore.getState().loadPlugins();

    // The plugin's entry point is handed to the sandbox as its `plugin://` URL
    // (wrapped mode), which the worker importScripts — no `blob:` (#2266).
    expect(loadPluginInSandbox).toHaveBeenCalledWith("fe", [
      "plugin://localhost/load/fe/frontend/index.js",
    ]);
    resetLoadedFrontendPlugins();
  });

  it("installPlugin installs, refreshes, and toasts success", async () => {
    const installed = makePlugin("new-plugin", "active");
    vi.mocked(apiInstallPlugin).mockResolvedValueOnce({ status: "installed", plugin: installed });
    vi.mocked(apiListPlugins).mockResolvedValueOnce([installed]);

    const change = await useAppStore
      .getState()
      .installPlugin("/tmp/new-plugin.termihub-plugin", true, false);

    expect(change).toBeNull();
    expect(apiInstallPlugin).toHaveBeenCalledWith(
      "/tmp/new-plugin.termihub-plugin",
      true,
      false,
      false
    );
    expect(toastLoading).toHaveBeenCalledTimes(1);
    expect(toastSuccess).toHaveBeenCalledWith("Installed Plugin new-plugin", { id: "toast-id" });
    expect(useAppStore.getState().plugins).toHaveLength(1);
  });

  it("installPlugin resolves the version change when confirmation is required (PLG-012)", async () => {
    const pending = {
      pluginId: "new-plugin",
      pluginName: "Plugin new-plugin",
      installedVersion: "1.4.0",
      incomingVersion: "1.2.0",
      kind: "downgrade" as const,
    };
    vi.mocked(apiInstallPlugin).mockResolvedValueOnce({
      status: "confirmationRequired",
      change: pending,
    });

    const change = await useAppStore
      .getState()
      .installPlugin("/tmp/new-plugin.termihub-plugin", true, false);

    expect(change).toEqual(pending);
    // Nothing installed: no refresh, no success toast.
    expect(apiListPlugins).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("installPlugin forwards an explicit version-change confirmation", async () => {
    const installed = makePlugin("new-plugin", "active");
    vi.mocked(apiInstallPlugin).mockResolvedValueOnce({ status: "installed", plugin: installed });
    vi.mocked(apiListPlugins).mockResolvedValueOnce([installed]);

    await useAppStore
      .getState()
      .installPlugin("/tmp/new-plugin.termihub-plugin", true, false, true);

    expect(apiInstallPlugin).toHaveBeenCalledWith(
      "/tmp/new-plugin.termihub-plugin",
      true,
      false,
      true
    );
  });

  it("installPlugin toasts an error and rethrows on failure", async () => {
    vi.mocked(apiInstallPlugin).mockRejectedValueOnce(new Error("bad package"));

    await expect(
      useAppStore.getState().installPlugin("/tmp/bad.termihub-plugin", true, false)
    ).rejects.toThrow("bad package");

    expect(toastError).toHaveBeenCalledWith("Failed to install plugin: bad package", {
      id: "toast-id",
    });
    expect(apiListPlugins).not.toHaveBeenCalled();
  });

  it("uninstallPlugin removes, refreshes, and toasts success", async () => {
    useAppStore.setState({ plugins: [makePlugin("gone", "active")] });
    vi.mocked(apiListPlugins).mockResolvedValueOnce([]);

    await useAppStore.getState().uninstallPlugin("gone");

    expect(apiUninstallPlugin).toHaveBeenCalledWith("gone");
    expect(toastSuccess).toHaveBeenCalledWith("Uninstalled Plugin gone", { id: "toast-id" });
    expect(useAppStore.getState().plugins).toEqual([]);
    expect(useAppStore.getState().pluginBackendTypes).toEqual([]);
  });

  it("uninstallPlugin toasts an error and rethrows on failure (TFE-006)", async () => {
    useAppStore.setState({ plugins: [makePlugin("gone", "active")] });
    vi.mocked(apiUninstallPlugin).mockRejectedValueOnce(new Error("in use"));

    await expect(useAppStore.getState().uninstallPlugin("gone")).rejects.toThrow("in use");

    expect(toastError).toHaveBeenCalledWith("Failed to uninstall Plugin gone: in use", {
      id: "toast-id",
    });
    // The list is not refreshed / cleared on failure.
    expect(useAppStore.getState().plugins.map((p) => p.manifest.id)).toEqual(["gone"]);
  });

  it("enablePlugin enables, refreshes, and toasts success with the plugin name", async () => {
    useAppStore.setState({ plugins: [makePlugin("toggle", "disabled")] });
    vi.mocked(apiListPlugins).mockResolvedValueOnce([makePlugin("toggle", "active")]);

    await useAppStore.getState().enablePlugin("toggle");

    expect(apiEnablePlugin).toHaveBeenCalledWith("toggle");
    expect(toastSuccess).toHaveBeenCalledWith("Enabled Plugin toggle", { id: "toast-id" });
    // The now-active backend appears in the projection.
    expect(useAppStore.getState().pluginBackendTypes).toEqual([
      { pluginId: "toggle", connectionType: "toggle", displayName: "Backend toggle" },
    ]);
  });

  it("enablePlugin toasts an error and rethrows on failure (TFE-006)", async () => {
    useAppStore.setState({ plugins: [makePlugin("toggle", "disabled")] });
    vi.mocked(apiEnablePlugin).mockRejectedValueOnce(new Error("incompatible"));

    await expect(useAppStore.getState().enablePlugin("toggle")).rejects.toThrow("incompatible");

    expect(toastError).toHaveBeenCalledWith("Failed to enable Plugin toggle: incompatible", {
      id: "toast-id",
    });
  });

  it("disablePlugin disables, refreshes, and toasts success", async () => {
    useAppStore.setState({ plugins: [makePlugin("toggle", "active")] });
    vi.mocked(apiListPlugins).mockResolvedValueOnce([makePlugin("toggle", "disabled")]);

    await useAppStore.getState().disablePlugin("toggle");

    expect(apiDisablePlugin).toHaveBeenCalledWith("toggle");
    expect(toastSuccess).toHaveBeenCalledWith("Disabled Plugin toggle", { id: "toast-id" });
    expect(useAppStore.getState().pluginBackendTypes).toEqual([]);
  });

  it("disablePlugin toasts an error and rethrows on failure", async () => {
    useAppStore.setState({ plugins: [makePlugin("toggle", "active")] });
    vi.mocked(apiDisablePlugin).mockRejectedValueOnce(new Error("cannot disable"));

    await expect(useAppStore.getState().disablePlugin("toggle")).rejects.toThrow("cannot disable");

    expect(toastError).toHaveBeenCalledWith("Failed to disable Plugin toggle: cannot disable", {
      id: "toast-id",
    });
  });

  it("falls back to the plugin id in feedback when it is not in state", async () => {
    vi.mocked(apiListPlugins).mockResolvedValueOnce([]);
    await useAppStore.getState().enablePlugin("unknown-id");
    expect(toastLoading).toHaveBeenCalledWith("Enabling unknown-id…");
    expect(toastSuccess).toHaveBeenCalledWith("Enabled unknown-id", { id: "toast-id" });
  });

  describe("plugin settings (#2000)", () => {
    it("getPluginSettings returns the stored settings object", async () => {
      vi.mocked(apiGetPluginSettings).mockResolvedValueOnce({ namespace: "prod" });
      const result = await useAppStore.getState().getPluginSettings("k8s");
      expect(apiGetPluginSettings).toHaveBeenCalledWith("k8s");
      expect(result).toEqual({ namespace: "prod" });
    });

    it("getPluginSettings rethrows on failure so the caller can fall back", async () => {
      vi.mocked(apiGetPluginSettings).mockRejectedValueOnce(new Error("read failed"));
      await expect(useAppStore.getState().getPluginSettings("k8s")).rejects.toThrow("read failed");
    });

    it("updatePluginSettings persists the values", async () => {
      await useAppStore.getState().updatePluginSettings("k8s", { namespace: "prod" });
      expect(apiUpdatePluginSettings).toHaveBeenCalledWith("k8s", { namespace: "prod" });
    });

    it("updatePluginSettings toasts a named error and rethrows on failure", async () => {
      useAppStore.setState({ plugins: [makePlugin("k8s", "active")] });
      vi.mocked(apiUpdatePluginSettings).mockRejectedValueOnce(new Error("disk full"));
      await expect(
        useAppStore.getState().updatePluginSettings("k8s", { namespace: "prod" })
      ).rejects.toThrow("disk full");
      expect(toastError).toHaveBeenCalledWith("Failed to save Plugin k8s settings: disk full");
    });
  });

  describe("error and edge branches (#2979)", () => {
    it("logs and skips a plugin theme that fails validation, registering only the good ones (#1996)", async () => {
      const themePlugin = makePlugin("badthemer", "active", { withBackend: false });
      vi.mocked(apiListPlugins).mockResolvedValueOnce([themePlugin]);
      const good: ThemeDefinition = {
        id: "plugin:badthemer:ok",
        name: "OK",
        colorScheme: "dark",
        colors: darkTheme.colors,
      };
      // One theme validates, one fails: the failure is logged and skipped, the
      // good one still flows through to the registry (the theme-error skip loop).
      vi.mocked(loadPluginThemes).mockResolvedValueOnce({
        themes: [good],
        errors: [
          { pluginId: "badthemer", themeId: "bad", file: "bad.json", message: "invalid color" },
        ],
      });

      await useAppStore.getState().loadPlugins();

      expect(loadPluginThemes).toHaveBeenCalledTimes(1);
      // Only the theme that validated is mirrored/registered; the bad one is dropped.
      expect(useAppStore.getState().pluginThemes).toEqual([good]);
      expect(setRegisteredPluginThemes).toHaveBeenCalledWith([good]);
    });

    it("loadPlugins tolerates a non-Error rejection (String(err) guard)", async () => {
      vi.mocked(apiListPlugins).mockRejectedValueOnce("backend exploded");
      await expect(useAppStore.getState().loadPlugins()).resolves.toBeUndefined();
      expect(useAppStore.getState().plugins).toEqual([]);
    });

    it("installPlugin toasts a non-Error rejection via String(err) and rethrows", async () => {
      vi.mocked(apiInstallPlugin).mockRejectedValueOnce("corrupt archive");
      await expect(
        useAppStore.getState().installPlugin("/tmp/x.termihub-plugin", false, false)
      ).rejects.toBe("corrupt archive");
      expect(toastError).toHaveBeenCalledWith("Failed to install plugin: corrupt archive", {
        id: "toast-id",
      });
    });

    it("uninstallPlugin falls back to the id, toasts an error, and rethrows on failure", async () => {
      // The plugin is not in state, so the feedback name falls back to the id.
      vi.mocked(apiUninstallPlugin).mockRejectedValueOnce(new Error("in use"));
      await expect(useAppStore.getState().uninstallPlugin("ghost")).rejects.toThrow("in use");
      expect(toastLoading).toHaveBeenCalledWith("Uninstalling ghost…");
      expect(toastError).toHaveBeenCalledWith("Failed to uninstall ghost: in use", {
        id: "toast-id",
      });
      expect(apiListPlugins).not.toHaveBeenCalled();
    });

    it("enablePlugin toasts an error and rethrows on failure", async () => {
      useAppStore.setState({ plugins: [makePlugin("toggle", "disabled")] });
      vi.mocked(apiEnablePlugin).mockRejectedValueOnce(new Error("boot failed"));
      await expect(useAppStore.getState().enablePlugin("toggle")).rejects.toThrow("boot failed");
      expect(toastError).toHaveBeenCalledWith("Failed to enable Plugin toggle: boot failed", {
        id: "toast-id",
      });
      expect(apiListPlugins).not.toHaveBeenCalled();
    });

    it("disablePlugin falls back to the id in feedback when the plugin is not in state", async () => {
      vi.mocked(apiListPlugins).mockResolvedValueOnce([]);
      await useAppStore.getState().disablePlugin("unknown-id");
      expect(toastLoading).toHaveBeenCalledWith("Disabling unknown-id…");
      expect(toastSuccess).toHaveBeenCalledWith("Disabled unknown-id", { id: "toast-id" });
    });

    it("getPluginSettings tolerates a non-Error rejection (String(err) guard) and rethrows", async () => {
      vi.mocked(apiGetPluginSettings).mockRejectedValueOnce("no such key");
      await expect(useAppStore.getState().getPluginSettings("k8s")).rejects.toBe("no such key");
    });

    it("updatePluginSettings toasts a non-Error rejection via String(err) and rethrows", async () => {
      vi.mocked(apiUpdatePluginSettings).mockRejectedValueOnce("quota exceeded");
      await expect(useAppStore.getState().updatePluginSettings("k8s", { a: 1 })).rejects.toBe(
        "quota exceeded"
      );
      expect(toastError).toHaveBeenCalledWith("Failed to save k8s settings: quota exceeded");
    });
  });

  describe("selectPlugin (#1997)", () => {
    it("opens a single plugin-detail tab titled after the plugin and records the selection", () => {
      useAppStore.setState({ plugins: [makePlugin("k8s", "active")] });

      useAppStore.getState().selectPlugin("k8s");

      const state = layoutState();
      expect(state.selectedPluginId).toBe("k8s");
      const tabs = state.rootPanel && "tabs" in state.rootPanel ? state.rootPanel.tabs : [];
      const detailTabs = tabs.filter((t) => t.contentType === "plugin-detail");
      expect(detailTabs).toHaveLength(1);
      expect(detailTabs[0].pluginDetailMeta).toEqual({ pluginId: "k8s" });
      expect(detailTabs[0].title).toBe("Plugin k8s");
      expect(detailTabs[0].isActive).toBe(true);
    });

    it("reuses the same detail tab when a different plugin is selected", () => {
      useAppStore.setState({
        plugins: [makePlugin("a", "active"), makePlugin("b", "disabled")],
      });

      useAppStore.getState().selectPlugin("a");
      useAppStore.getState().selectPlugin("b");

      const state = layoutState();
      const tabs = state.rootPanel && "tabs" in state.rootPanel ? state.rootPanel.tabs : [];
      const detailTabs = tabs.filter((t) => t.contentType === "plugin-detail");
      expect(detailTabs).toHaveLength(1);
      expect(detailTabs[0].pluginDetailMeta).toEqual({ pluginId: "b" });
      expect(state.selectedPluginId).toBe("b");
    });
  });
});
