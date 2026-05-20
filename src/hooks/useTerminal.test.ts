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

import { useAppStore } from "@/store/appStore";

/** Get the active group from current store state. */
function getActiveGroup() {
  const state = useAppStore.getState();
  return state.tabGroups.find((g) => g.id === state.activeTabGroupId)!;
}

describe("useTerminal logic (via store)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
  });

  describe("openTerminal (addTab)", () => {
    it("adds a new tab to the active group", () => {
      const { addTab } = useAppStore.getState();
      expect(getActiveGroup().tabs).toHaveLength(0);

      addTab("SSH - pi.local", "ssh");

      expect(getActiveGroup().tabs).toHaveLength(1);
      expect(getActiveGroup().tabs[0].title).toBe("SSH - pi.local");
    });

    it("tab has the correct connection type", () => {
      useAppStore.getState().addTab("Local Shell", "local");

      const tab = getActiveGroup().tabs[0];
      expect(tab.connectionType).toBe("local");
    });

    it("multiple calls add multiple tabs", () => {
      useAppStore.getState().addTab("Tab 1", "local");
      useAppStore.getState().addTab("Tab 2", "local");
      useAppStore.getState().addTab("Tab 3", "ssh");

      expect(getActiveGroup().tabs).toHaveLength(3);
    });
  });

  describe("closeTerminal (closeTab)", () => {
    it("removes the specified tab from the group", () => {
      const { addTab } = useAppStore.getState();
      addTab("To Close", "local");

      const group = getActiveGroup();
      const tabId = group.tabs[0].id;
      const panelId = group.activeTabSetId ?? "";

      useAppStore.getState().closeTab(tabId, panelId);

      expect(getActiveGroup().tabs).toHaveLength(0);
    });

    it("does not affect other tabs when closing one", () => {
      useAppStore.getState().addTab("Keep", "local");
      useAppStore.getState().addTab("Close", "local");

      const group = getActiveGroup();
      const closeTab = group.tabs[1];

      useAppStore.getState().closeTab(closeTab.id, group.activeTabSetId ?? "");

      const remaining = getActiveGroup();
      expect(remaining.tabs).toHaveLength(1);
      expect(remaining.tabs[0].title).toBe("Keep");
    });
  });

  describe("activateTerminal (setActiveTab)", () => {
    it("sets the active tab in the group", () => {
      useAppStore.getState().addTab("Tab A", "local");
      useAppStore.getState().addTab("Tab B", "local");

      const group = getActiveGroup();
      const tabA = group.tabs[0];
      const tabB = group.tabs[1];

      // Tab B is active by default (last added)
      expect(group.activeTabId).toBe(tabB.id);

      useAppStore.getState().setActiveTab(tabA.id, group.activeTabSetId ?? "");

      expect(getActiveGroup().activeTabId).toBe(tabA.id);
    });
  });
});
