import { describe, it, expect, beforeEach, vi } from "vitest";

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

vi.mock("@/services/api", () => ({
  sftpOpen: vi.fn(),
  sftpClose: vi.fn(),
  sftpListDir: vi.fn(),
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
}));

import { useAppStore } from "./appStore";

describe("terminal spawn error state", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
  });

  it("setTerminalSpawnError sets an error for a tab", () => {
    useAppStore.getState().setTerminalSpawnError("tab-1", "Connection refused");
    expect(useAppStore.getState().terminalSpawnErrors["tab-1"]).toBe("Connection refused");
  });

  it("setTerminalSpawnError with null clears the error", () => {
    useAppStore.getState().setTerminalSpawnError("tab-1", "some error");
    useAppStore.getState().setTerminalSpawnError("tab-1", null);
    expect(useAppStore.getState().terminalSpawnErrors["tab-1"]).toBeUndefined();
  });

  it("retryTerminalSpawn clears error and increments counter", () => {
    useAppStore.getState().setTerminalSpawnError("tab-1", "timeout");
    useAppStore.getState().retryTerminalSpawn("tab-1");
    expect(useAppStore.getState().terminalSpawnErrors["tab-1"]).toBeUndefined();
    expect(useAppStore.getState().terminalRetryCounters["tab-1"]).toBe(1);
  });

  it("retryTerminalSpawn increments counter on each call", () => {
    useAppStore.getState().retryTerminalSpawn("tab-1");
    useAppStore.getState().retryTerminalSpawn("tab-1");
    expect(useAppStore.getState().terminalRetryCounters["tab-1"]).toBe(2);
  });

  it("closeTab removes spawn error and retry counter", () => {
    const store = useAppStore.getState();
    // Add a terminal tab via addTab so we have a valid panelId
    const panelId = store.activePanelId!;
    store.addTab("Test", "local");
    const tab =
      useAppStore.getState().rootPanel.type === "leaf"
        ? useAppStore.getState().rootPanel.tabs.at(-1)!
        : null;
    expect(tab).not.toBeNull();

    useAppStore.getState().setTerminalSpawnError(tab!.id, "error");
    useAppStore.getState().retryTerminalSpawn(tab!.id);
    useAppStore.getState().setTerminalSpawnError(tab!.id, "error again");

    useAppStore.getState().closeTab(tab!.id, panelId);

    expect(useAppStore.getState().terminalSpawnErrors[tab!.id]).toBeUndefined();
    expect(useAppStore.getState().terminalRetryCounters[tab!.id]).toBeUndefined();
  });
});
