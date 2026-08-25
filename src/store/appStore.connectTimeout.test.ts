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
import { connectTimeoutMessage } from "@/utils/connectTimeout";

describe("failTerminalConnectTimeout — waiting-for-agent", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
  });

  it("transitions a parked waiting-for-agent tab to Failed with a contextual hint", () => {
    useAppStore.getState().setTerminalWaitingForAgent("tab-1", "agent-1");
    useAppStore.getState().failTerminalConnectTimeout("tab-1", "waiting-for-agent");

    // No longer waiting — cannot hang forever.
    expect(useAppStore.getState().terminalWaitingForAgent["tab-1"]).toBeUndefined();
    // Failed state carries the contextual timeout hint.
    expect(useAppStore.getState().terminalSpawnErrors["tab-1"]).toBe(
      connectTimeoutMessage("waiting-for-agent")
    );
  });

  it("is a no-op if the tab is no longer waiting for the agent (agent came online)", () => {
    // Tab was waiting, then the agent connected and the wait was cleared.
    useAppStore.getState().setTerminalWaitingForAgent("tab-1", "agent-1");
    useAppStore.getState().setTerminalWaitingForAgent("tab-1", null);

    // A late/stale timer fires — it must not resurrect a Failed state.
    useAppStore.getState().failTerminalConnectTimeout("tab-1", "waiting-for-agent");

    expect(useAppStore.getState().terminalSpawnErrors["tab-1"]).toBeUndefined();
  });
});

describe("failTerminalConnectTimeout — connecting", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
  });

  it("transitions a stuck connecting tab to Failed with a contextual hint", () => {
    useAppStore.getState().setTerminalConnecting("tab-1", true);
    useAppStore.getState().failTerminalConnectTimeout("tab-1", "connecting");

    expect(useAppStore.getState().terminalConnectDeadline["tab-1"]).toBeUndefined();
    expect(useAppStore.getState().terminalSpawnErrors["tab-1"]).toBe(
      connectTimeoutMessage("connecting")
    );
  });

  it("is a no-op if the tab is no longer connecting (connect succeeded)", () => {
    useAppStore.getState().setTerminalConnecting("tab-1", true);
    useAppStore.getState().setTerminalConnecting("tab-1", false);

    useAppStore.getState().failTerminalConnectTimeout("tab-1", "connecting");

    expect(useAppStore.getState().terminalSpawnErrors["tab-1"]).toBeUndefined();
  });
});
