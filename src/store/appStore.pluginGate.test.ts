/**
 * Regression test for #2630 — disabling the experimental frontend-plugin gate
 * (`frontendPluginsEnabled`) live must unmount the plugin's widget and unload its
 * sandbox, even while the authoritative `settings` region is still catching up.
 *
 * The bug: `updateSettings` fires the gate-off transition into the region
 * fire-and-forget (`mirrorSettingsIntent`), then kicks `loadPlugins`, which read
 * the gate back from the *eventually-consistent* region via
 * `currentSettingsView()`. If the region diff had not landed yet, reconcile ran
 * with the stale `enabled = true`, kept the plugin loaded, and nothing re-ran
 * reconcile when the diff arrived — so the widget never unmounted.
 *
 * These tests drive the disable through `updateSettings` against a region that is
 * deliberately held stale (a non-reflecting transport double, mirroring the async
 * production region) so reconcile must use the known-new gate value the caller
 * already has, not the region read.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { loadPluginInSandbox, unloadPluginFromSandbox } = vi.hoisted(() => ({
  // Observe the frontend-plugin reconcile without a real Web Worker (#2266).
  loadPluginInSandbox: vi.fn(),
  unloadPluginFromSandbox: vi.fn(),
}));
vi.mock("@/plugins/sandbox/pluginSandboxHost", () => ({
  loadPluginInSandbox,
  unloadPluginFromSandbox,
}));
vi.mock("@/components/ui", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(() => "toast-id"),
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
  sftpOpen: vi.fn(),
  sftpClose: vi.fn(() => Promise.resolve()),
  sftpListDir: vi.fn(),
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
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
import { listPlugins as apiListPlugins } from "@/services/api";
import { loadedFrontendPluginIds, resetLoadedFrontendPlugins } from "@/plugins/frontendPlugins";
import { __emitSettingsViewForTest, currentSettingsView } from "@/store/settingsBridge";
import {
  installSettingsHarness,
  settingsDoc,
  type FakeSettingsTransport,
} from "@/test/settingsRegionTestHarness";
import type { AppSettings } from "@/types/connection";
import type { InstalledPlugin } from "@/types/plugin";

/** A plugin declaring a frontend (JS) extension — a protocol-parser entry point. */
function frontendPlugin(id: string): InstalledPlugin {
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
    state: "active",
    installedAt: "2026-07-26T00:00:00Z",
  };
}

describe("appStore — frontend-plugin gate live disable (#2630)", () => {
  let harness: { transport: FakeSettingsTransport; teardown: () => void };

  /**
   * Prime the `settings` region to `doc` — both seed the transport and commit the
   * view synchronously so `currentSettingsView()` reflects it now. Because the
   * harness is installed with `reflectDispatch: false`, a *later* `settings.replace`
   * dispatch folds the transport's document but never updates the projected view,
   * so `currentSettingsView()` stays deliberately stale — modelling the async
   * production region that has not delivered its diff yet.
   */
  function primeRegion(doc: AppSettings): void {
    harness.transport.seed(doc);
    __emitSettingsViewForTest(doc, harness.transport.currentVersion());
  }

  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
    resetLoadedFrontendPlugins();
    harness = installSettingsHarness(undefined, { reflectDispatch: false });
  });

  afterEach(() => {
    harness.teardown();
    resetLoadedFrontendPlugins();
  });

  it("unmounts the widget when the gate flips off while the region read is still stale", async () => {
    // Gate on, plugin active → the sandbox loads it (widget mounted).
    primeRegion(settingsDoc({ frontendPluginsEnabled: true }));
    vi.mocked(apiListPlugins).mockResolvedValue([frontendPlugin("fe")]);
    await useAppStore.getState().loadPlugins();
    expect(loadPluginInSandbox).toHaveBeenCalledWith("fe", [
      "plugin://localhost/load/fe/frontend/index.js",
    ]);
    expect(loadedFrontendPluginIds()).toEqual(["fe"]);
    unloadPluginFromSandbox.mockClear();

    // Live-disable the gate. The region is held stale (still reports `true`), so a
    // reconcile that reads the gate from `currentSettingsView()` would keep the
    // plugin loaded. The fix threads the known-new value instead.
    await useAppStore.getState().updateSettings(settingsDoc({ frontendPluginsEnabled: false }));
    // Sanity: the region genuinely has NOT caught up — this is the race we guard.
    expect(currentSettingsView().frontendPluginsEnabled).toBe(true);

    // The gate-change branch reconciles via a floating `loadPlugins`; wait for the
    // teardown rather than a fixed tick.
    await vi.waitFor(() => {
      expect(unloadPluginFromSandbox).toHaveBeenCalledWith("fe");
    });
    expect(loadedFrontendPluginIds()).toEqual([]);
  });

  it("keeps the widget mounted when the gate flips on while the region read is still stale", async () => {
    // Gate off, plugin active → nothing loaded.
    primeRegion(settingsDoc({ frontendPluginsEnabled: false }));
    vi.mocked(apiListPlugins).mockResolvedValue([frontendPlugin("fe")]);
    await useAppStore.getState().loadPlugins();
    expect(loadPluginInSandbox).not.toHaveBeenCalled();
    expect(loadedFrontendPluginIds()).toEqual([]);

    // Live-enable the gate while the region still reports `false`.
    await useAppStore.getState().updateSettings(settingsDoc({ frontendPluginsEnabled: true }));
    expect(currentSettingsView().frontendPluginsEnabled).toBe(false);

    await vi.waitFor(() => {
      expect(loadPluginInSandbox).toHaveBeenCalledWith("fe", [
        "plugin://localhost/load/fe/frontend/index.js",
      ]);
    });
    expect(loadedFrontendPluginIds()).toEqual(["fe"]);
  });
});
