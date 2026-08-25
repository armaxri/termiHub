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

import { useAppStore, ABORTED_CONNECT_MESSAGE } from "./appStore";

describe("abortTerminalConnect", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
  });

  it("transitions a connecting tab to a retryable Failed state without closing the tab", () => {
    useAppStore.getState().setTerminalConnecting("tab-1", true);

    useAppStore.getState().abortTerminalConnect("tab-1");

    // No longer counting down the connect deadline (the connecting overlay is now
    // sourced from the region; the deadline is the surviving per-client timer).
    expect(useAppStore.getState().terminalConnectDeadline["tab-1"]).toBeUndefined();
    // Landed on a retryable Failed state (spawn error set = overlay shows Retry).
    expect(useAppStore.getState().terminalSpawnErrors["tab-1"]).toBe(ABORTED_CONNECT_MESSAGE);
  });

  it("transitions a waiting-for-agent tab to Failed and stops waiting", () => {
    useAppStore.getState().setTerminalWaitingForAgent("tab-1", "agent-1");

    useAppStore.getState().abortTerminalConnect("tab-1");

    expect(useAppStore.getState().terminalWaitingForAgent["tab-1"]).toBeUndefined();
    expect(useAppStore.getState().terminalSpawnErrors["tab-1"]).toBe(ABORTED_CONNECT_MESSAGE);
  });

  it("transitions an auto-retrying tab to Failed and stops the retry loop", () => {
    useAppStore.getState().setTerminalAutoRetrying("tab-1", 3);

    useAppStore.getState().abortTerminalConnect("tab-1");

    expect(useAppStore.getState().terminalAutoRetryCount["tab-1"]).toBeUndefined();
    expect(useAppStore.getState().terminalSpawnErrors["tab-1"]).toBe(ABORTED_CONNECT_MESSAGE);
  });

  it("does not touch other tabs", () => {
    useAppStore.getState().setTerminalConnecting("tab-1", true);
    useAppStore.getState().setTerminalConnecting("tab-2", true);

    useAppStore.getState().abortTerminalConnect("tab-1");

    // tab-1's connect deadline is cleared; tab-2's is untouched.
    expect(useAppStore.getState().terminalConnectDeadline["tab-1"]).toBeUndefined();
    expect(useAppStore.getState().terminalConnectDeadline["tab-2"]?.kind).toBe("connecting");
    expect(useAppStore.getState().terminalSpawnErrors["tab-2"]).toBeUndefined();
  });
});
