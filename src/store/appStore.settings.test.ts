import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { TerminalTab, LeafPanel } from "@/types/terminal";

// Mock service modules before importing the store
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

const mockSessionMonitoringClose = vi.fn((_sessionId: string) => Promise.resolve());
const mockSftpClose = vi.fn((_sessionId: string) => Promise.resolve());

const mockApplyTheme = vi.fn<(setting: string | undefined) => void>();
const mockOnThemeChange = vi.fn<(callback: () => void) => () => void>(() => vi.fn());

vi.mock("@/themes", () => ({
  applyTheme: (setting: string | undefined) => mockApplyTheme(setting),
  onThemeChange: (callback: () => void) => mockOnThemeChange(callback),
}));

vi.mock("@/services/api", () => ({
  sftpOpen: vi.fn(),
  sftpClose: (sessionId: string) => mockSftpClose(sessionId),
  sftpListDir: vi.fn(),
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
  sessionMonitoringClose: (sessionId: string) => mockSessionMonitoringClose(sessionId),
}));

import { useAppStore } from "./appStore";
import { layoutState, seedLayoutState } from "@/test/layoutState";
import { currentSettingsView } from "./settingsBridge";
import { ensureMonitorsSubscribed } from "./systemMonitorBridge";
import {
  fakeMonitor,
  installMonitorHarness,
  monitorsView,
  type FakeMonitorTransport,
} from "@/test/systemMonitorHarness";
import { seedSettings, setupSettingsRegion, settingsDoc } from "@/test/settingsRegionTestHarness";
import { flushMacrotask } from "@/test/flushAsync";

let transport: FakeMonitorTransport;
let teardownMonitors: () => void;

/**
 * Seed the authoritative `system-monitors` region with one live monitor keyed by
 * its owning session id (#2224 — monitor state no longer lives in `appStore`).
 */
async function seedMonitor(sessionId: string, host: string): Promise<void> {
  await ensureMonitorsSubscribed();
  transport.seed(monitorsView([fakeMonitor(sessionId, { host, monitorSessionId: sessionId })]));
  await flushMacrotask();
}

describe("appStore — settings toggles", () => {
  // The persisted settings document is region-authoritative (#2404): seed the
  // `settings` region, not an `appStore` slice, and read it back via the projection.
  setupSettingsRegion();

  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
    ({ transport, teardown: teardownMonitors } = installMonitorHarness());
  });

  afterEach(() => {
    teardownMonitors();
  });

  it("disabling power monitoring disconnects active monitoring session", async () => {
    // Set up connected monitoring state in the authoritative region.
    await seedMonitor("mon-1", "pi@pi.local:22");
    seedSettings({ powerMonitoringEnabled: true, fileBrowserEnabled: true });

    await useAppStore
      .getState()
      .updateSettings(settingsDoc({ powerMonitoringEnabled: false, fileBrowserEnabled: true }));

    expect(currentSettingsView().powerMonitoringEnabled).toBe(false);
    expect(mockSessionMonitoringClose).toHaveBeenCalledWith("mon-1");
  });

  it("disabling file browser switches sidebar from files to connections", async () => {
    // Files sidebar view is open when the file browser is turned off.
    useAppStore.setState({ sidebarView: "files" });
    seedSettings({ powerMonitoringEnabled: true, fileBrowserEnabled: true });

    await useAppStore
      .getState()
      .updateSettings(settingsDoc({ powerMonitoringEnabled: true, fileBrowserEnabled: false }));

    const state = layoutState();
    expect(currentSettingsView().fileBrowserEnabled).toBe(false);
    expect(state.sidebarView).toBe("connections");
  });

  it("disabling one feature does not affect the other", async () => {
    await seedMonitor("mon-1", "pi@pi.local:22");
    useAppStore.setState({ sidebarView: "files" });
    seedSettings({ powerMonitoringEnabled: true, fileBrowserEnabled: true });

    // Disable only power monitoring
    await useAppStore
      .getState()
      .updateSettings(settingsDoc({ powerMonitoringEnabled: false, fileBrowserEnabled: true }));

    const state = layoutState();
    // Monitoring disconnected via the backend close command.
    expect(mockSessionMonitoringClose).toHaveBeenCalledWith("mon-1");
    // File browser untouched: the files sidebar stays open.
    expect(state.sidebarView).toBe("files");
  });

  it("does not disconnect when feature was already disabled", async () => {
    seedSettings({ powerMonitoringEnabled: false, fileBrowserEnabled: false });

    // Re-save with same disabled values — no side effects
    await useAppStore
      .getState()
      .updateSettings(settingsDoc({ powerMonitoringEnabled: false, fileBrowserEnabled: false }));

    expect(mockSessionMonitoringClose).not.toHaveBeenCalled();
    expect(mockSftpClose).not.toHaveBeenCalled();
  });

  /** Helper: create a panel with an SSH tab that has per-connection overrides. */
  function sshTabPanel(overrides: { enableMonitoring?: boolean; enableFileBrowser?: boolean }): {
    rootPanel: LeafPanel;
    activePanelId: string;
  } {
    const tab: TerminalTab = {
      id: "tab-1",
      sessionId: "sess-1",
      title: "SSH",
      connectionType: "ssh",
      contentType: "terminal",
      config: {
        type: "ssh",
        config: {
          host: "pi.local",
          port: 22,
          username: "pi",
          authMethod: "password" as const,
          ...overrides,
        },
      },
      panelId: "panel-1",
      isActive: true,
    };
    const panel: LeafPanel = {
      type: "leaf",
      id: "panel-1",
      tabs: [tab],
      activeTabId: "tab-1",
    };
    return { rootPanel: panel, activePanelId: "panel-1" };
  }

  it("disabling global monitoring keeps session when active tab has explicit enableMonitoring=true", async () => {
    await seedMonitor("mon-1", "pi@pi.local:22");
    seedLayoutState(sshTabPanel({ enableMonitoring: true }));
    seedSettings({ powerMonitoringEnabled: true, fileBrowserEnabled: true });

    await useAppStore
      .getState()
      .updateSettings(settingsDoc({ powerMonitoringEnabled: false, fileBrowserEnabled: true }));

    // Monitoring should NOT be disconnected — the active tab has an explicit override
    expect(mockSessionMonitoringClose).not.toHaveBeenCalled();
  });

  it("disabling global file browser keeps the files sidebar when active tab has explicit enableFileBrowser=true", async () => {
    useAppStore.setState({ sidebarView: "files" });
    seedLayoutState(sshTabPanel({ enableFileBrowser: true }));
    seedSettings({ powerMonitoringEnabled: true, fileBrowserEnabled: true });

    await useAppStore
      .getState()
      .updateSettings(settingsDoc({ powerMonitoringEnabled: true, fileBrowserEnabled: false }));

    // Sidebar should NOT switch away — the active tab has an explicit override.
    expect(useAppStore.getState().sidebarView).toBe("files");
  });

  it("disabling global monitoring disconnects when active tab uses default (no override)", async () => {
    await seedMonitor("mon-1", "pi@pi.local:22");
    seedLayoutState(sshTabPanel({})); // No per-connection override
    seedSettings({ powerMonitoringEnabled: true, fileBrowserEnabled: true });

    await useAppStore
      .getState()
      .updateSettings(settingsDoc({ powerMonitoringEnabled: false, fileBrowserEnabled: true }));

    // Should disconnect because the active tab inherits the global default
    expect(mockSessionMonitoringClose).toHaveBeenCalledWith("mon-1");
  });

  it("calls applyTheme when theme changes via updateSettings", async () => {
    seedSettings({ powerMonitoringEnabled: true, fileBrowserEnabled: true, theme: "dark" });

    await useAppStore
      .getState()
      .updateSettings(
        settingsDoc({ powerMonitoringEnabled: true, fileBrowserEnabled: true, theme: "light" })
      );

    expect(mockApplyTheme).toHaveBeenCalledWith("light");
  });

  it("does not call applyTheme when theme is unchanged", async () => {
    seedSettings({ powerMonitoringEnabled: true, fileBrowserEnabled: true, theme: "dark" });

    await useAppStore
      .getState()
      .updateSettings(
        settingsDoc({ powerMonitoringEnabled: false, fileBrowserEnabled: true, theme: "dark" })
      );

    expect(mockApplyTheme).not.toHaveBeenCalled();
  });

  it("calls applyTheme('system') when switching to system mode", async () => {
    seedSettings({ powerMonitoringEnabled: true, fileBrowserEnabled: true, theme: "dark" });

    await useAppStore
      .getState()
      .updateSettings(
        settingsDoc({ powerMonitoringEnabled: true, fileBrowserEnabled: true, theme: "system" })
      );

    expect(mockApplyTheme).toHaveBeenCalledWith("system");
  });

  it("calls applyTheme when switching from system to light", async () => {
    seedSettings({ powerMonitoringEnabled: true, fileBrowserEnabled: true, theme: "system" });

    await useAppStore
      .getState()
      .updateSettings(
        settingsDoc({ powerMonitoringEnabled: true, fileBrowserEnabled: true, theme: "light" })
      );

    expect(mockApplyTheme).toHaveBeenCalledWith("light");
  });

  it("persists theme setting via saveSettings", async () => {
    const { saveSettings } = await import("@/services/storage");

    seedSettings({ powerMonitoringEnabled: true, fileBrowserEnabled: true, theme: "dark" });

    await useAppStore
      .getState()
      .updateSettings(
        settingsDoc({ powerMonitoringEnabled: true, fileBrowserEnabled: true, theme: "light" })
      );

    expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({ theme: "light" }));
  });
});

describe("appStore — theme initialization on loadFromBackend", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
  });

  it("applies theme from settings on initial load", async () => {
    const { getSettings } = await import("@/services/storage");
    vi.mocked(getSettings).mockResolvedValueOnce({
      version: "1",
      externalConnectionFiles: [],
      powerMonitoringEnabled: true,
      fileBrowserEnabled: true,
      theme: "light",
    });

    await useAppStore.getState().loadFromBackend();

    expect(mockApplyTheme).toHaveBeenCalledWith("light");
  });

  it("applies undefined theme when settings have no theme field", async () => {
    const { getSettings } = await import("@/services/storage");
    vi.mocked(getSettings).mockResolvedValueOnce({
      version: "1",
      externalConnectionFiles: [],
      powerMonitoringEnabled: true,
      fileBrowserEnabled: true,
    });

    await useAppStore.getState().loadFromBackend();

    expect(mockApplyTheme).toHaveBeenCalledWith(undefined);
  });

  it("registers onThemeChange callback on initial load", async () => {
    const { getSettings } = await import("@/services/storage");
    vi.mocked(getSettings).mockResolvedValueOnce({
      version: "1",
      externalConnectionFiles: [],
      powerMonitoringEnabled: true,
      fileBrowserEnabled: true,
      theme: "system",
    });

    await useAppStore.getState().loadFromBackend();

    expect(mockOnThemeChange).toHaveBeenCalledTimes(1);
    expect(mockOnThemeChange).toHaveBeenCalledWith(expect.any(Function));
  });
});
