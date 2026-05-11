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

describe("terminalReattaching state", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
  });

  it("setTerminalReattaching(true) sets flag for a tab", () => {
    useAppStore.getState().setTerminalReattaching("tab-1", true);
    expect(useAppStore.getState().terminalReattaching["tab-1"]).toBe(true);
  });

  it("setTerminalReattaching(false) removes the flag", () => {
    useAppStore.getState().setTerminalReattaching("tab-1", true);
    useAppStore.getState().setTerminalReattaching("tab-1", false);
    expect(useAppStore.getState().terminalReattaching["tab-1"]).toBeUndefined();
  });

  it("does not affect other tabs when setting flag", () => {
    useAppStore.getState().setTerminalReattaching("tab-1", true);
    useAppStore.getState().setTerminalReattaching("tab-2", true);
    useAppStore.getState().setTerminalReattaching("tab-1", false);
    expect(useAppStore.getState().terminalReattaching["tab-2"]).toBe(true);
    expect(useAppStore.getState().terminalReattaching["tab-1"]).toBeUndefined();
  });

  it("initialises to empty record", () => {
    expect(useAppStore.getState().terminalReattaching).toEqual({});
  });

  it("closeTab removes terminalReattaching flag for the closed tab", () => {
    const store = useAppStore.getState();
    const panelId = store.activePanelId!;
    store.addTab("Test", "local");

    const rootPanel = useAppStore.getState().rootPanel;
    const leafTabs = rootPanel.type === "leaf" ? rootPanel.tabs : [];
    const tab = leafTabs[leafTabs.length - 1];
    expect(tab).toBeDefined();

    useAppStore.getState().setTerminalReattaching(tab.id, true);
    expect(useAppStore.getState().terminalReattaching[tab.id]).toBe(true);

    useAppStore.getState().closeTab(tab.id, panelId);
    expect(useAppStore.getState().terminalReattaching[tab.id]).toBeUndefined();
  });
});
