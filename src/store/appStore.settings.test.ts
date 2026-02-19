import { describe, it, expect, beforeEach, vi } from "vitest";

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

const mockMonitoringClose = vi.fn(() => Promise.resolve());
const mockSftpClose = vi.fn(() => Promise.resolve());

vi.mock("@/services/api", () => ({
  sftpOpen: vi.fn(),
  sftpClose: (...args: unknown[]) => mockSftpClose(...args),
  sftpListDir: vi.fn(),
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
  monitoringOpen: vi.fn(),
  monitoringClose: (...args: unknown[]) => mockMonitoringClose(...args),
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
});
