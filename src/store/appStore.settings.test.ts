import { describe, it, expect, beforeEach, vi } from "vitest";
import { TerminalTab, LeafPanel } from "@/types/terminal";

// Mock service modules before importing the store
vi.mock("@/services/storage", () => ({
  loadConnections: vi.fn(() =>
    Promise.resolve({ connections: [], folders: [], externalSources: [] })
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
  saveExternalFile: vi.fn(() => Promise.resolve()),
  reloadExternalConnections: vi.fn(() => Promise.resolve([])),
}));

const mockMonitoringClose = vi.fn((_sessionId: string) => Promise.resolve());
const mockSftpClose = vi.fn((_sessionId: string) => Promise.resolve());

vi.mock("@/services/api", () => ({
  sftpOpen: vi.fn(),
  sftpClose: (sessionId: string) => mockSftpClose(sessionId),
  sftpListDir: vi.fn(),
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
  monitoringOpen: vi.fn(),
  monitoringClose: (sessionId: string) => mockMonitoringClose(sessionId),
  monitoringFetchStats: vi.fn(),
}));

import { useAppStore } from "./appStore";

describe("appStore — settings toggles", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
  });

  it("disabling power monitoring disconnects active monitoring session", async () => {
    // Set up connected monitoring state
    useAppStore.setState({
      monitoringSessionId: "mon-1",
      monitoringHost: "pi@pi.local:22",
      settings: {
        version: "1",
        externalConnectionFiles: [],
        powerMonitoringEnabled: true,
        fileBrowserEnabled: true,
      },
    });

    await useAppStore.getState().updateSettings({
      version: "1",
      externalConnectionFiles: [],
      powerMonitoringEnabled: false,
      fileBrowserEnabled: true,
    });

    const state = useAppStore.getState();
    expect(state.settings.powerMonitoringEnabled).toBe(false);
    expect(state.monitoringSessionId).toBeNull();
    expect(state.monitoringHost).toBeNull();
    expect(mockMonitoringClose).toHaveBeenCalledWith("mon-1");
  });

  it("disabling file browser disconnects SFTP and switches sidebar to connections", async () => {
    // Set up connected SFTP state and files sidebar view
    useAppStore.setState({
      sftpSessionId: "sftp-1",
      sftpConnectedHost: "pi@pi.local:22",
      sidebarView: "files",
      settings: {
        version: "1",
        externalConnectionFiles: [],
        powerMonitoringEnabled: true,
        fileBrowserEnabled: true,
      },
    });

    await useAppStore.getState().updateSettings({
      version: "1",
      externalConnectionFiles: [],
      powerMonitoringEnabled: true,
      fileBrowserEnabled: false,
    });

    const state = useAppStore.getState();
    expect(state.settings.fileBrowserEnabled).toBe(false);
    expect(state.sftpSessionId).toBeNull();
    expect(state.sidebarView).toBe("connections");
    expect(mockSftpClose).toHaveBeenCalledWith("sftp-1");
  });

  it("disabling one feature does not affect the other", async () => {
    useAppStore.setState({
      monitoringSessionId: "mon-1",
      monitoringHost: "pi@pi.local:22",
      sftpSessionId: "sftp-1",
      sftpConnectedHost: "pi@pi.local:22",
      sidebarView: "files",
      settings: {
        version: "1",
        externalConnectionFiles: [],
        powerMonitoringEnabled: true,
        fileBrowserEnabled: true,
      },
    });

    // Disable only power monitoring
    await useAppStore.getState().updateSettings({
      version: "1",
      externalConnectionFiles: [],
      powerMonitoringEnabled: false,
      fileBrowserEnabled: true,
    });

    const state = useAppStore.getState();
    // Monitoring disconnected
    expect(state.monitoringSessionId).toBeNull();
    // SFTP still connected
    expect(state.sftpSessionId).toBe("sftp-1");
    expect(state.sidebarView).toBe("files");
    expect(mockSftpClose).not.toHaveBeenCalled();
  });

  it("does not disconnect when feature was already disabled", async () => {
    useAppStore.setState({
      settings: {
        version: "1",
        externalConnectionFiles: [],
        powerMonitoringEnabled: false,
        fileBrowserEnabled: false,
      },
    });

    // Re-save with same disabled values — no side effects
    await useAppStore.getState().updateSettings({
      version: "1",
      externalConnectionFiles: [],
      powerMonitoringEnabled: false,
      fileBrowserEnabled: false,
    });

    expect(mockMonitoringClose).not.toHaveBeenCalled();
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
    useAppStore.setState({
      monitoringSessionId: "mon-1",
      monitoringHost: "pi@pi.local:22",
      ...sshTabPanel({ enableMonitoring: true }),
      settings: {
        version: "1",
        externalConnectionFiles: [],
        powerMonitoringEnabled: true,
        fileBrowserEnabled: true,
      },
    });

    await useAppStore.getState().updateSettings({
      version: "1",
      externalConnectionFiles: [],
      powerMonitoringEnabled: false,
      fileBrowserEnabled: true,
    });

    // Monitoring should NOT be disconnected — the active tab has an explicit override
    expect(mockMonitoringClose).not.toHaveBeenCalled();
    expect(useAppStore.getState().monitoringSessionId).toBe("mon-1");
  });

  it("disabling global file browser keeps SFTP when active tab has explicit enableFileBrowser=true", async () => {
    useAppStore.setState({
      sftpSessionId: "sftp-1",
      sftpConnectedHost: "pi@pi.local:22",
      sidebarView: "files",
      ...sshTabPanel({ enableFileBrowser: true }),
      settings: {
        version: "1",
        externalConnectionFiles: [],
        powerMonitoringEnabled: true,
        fileBrowserEnabled: true,
      },
    });

    await useAppStore.getState().updateSettings({
      version: "1",
      externalConnectionFiles: [],
      powerMonitoringEnabled: true,
      fileBrowserEnabled: false,
    });

    // SFTP should NOT be disconnected — the active tab has an explicit override
    expect(mockSftpClose).not.toHaveBeenCalled();
    expect(useAppStore.getState().sftpSessionId).toBe("sftp-1");
    expect(useAppStore.getState().sidebarView).toBe("files");
  });

  it("disabling global monitoring disconnects when active tab uses default (no override)", async () => {
    useAppStore.setState({
      monitoringSessionId: "mon-1",
      monitoringHost: "pi@pi.local:22",
      ...sshTabPanel({}), // No per-connection override
      settings: {
        version: "1",
        externalConnectionFiles: [],
        powerMonitoringEnabled: true,
        fileBrowserEnabled: true,
      },
    });

    await useAppStore.getState().updateSettings({
      version: "1",
      externalConnectionFiles: [],
      powerMonitoringEnabled: false,
      fileBrowserEnabled: true,
    });

    // Should disconnect because the active tab inherits the global default
    expect(mockMonitoringClose).toHaveBeenCalledWith("mon-1");
  });
});
