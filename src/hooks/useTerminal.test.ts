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
import { getAllLeaves } from "@/utils/panelTree";

describe("useTerminal logic (via store)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
  });

  describe("openTerminal (addTab)", () => {
    it("adds a new tab to the active panel", () => {
      const { addTab, rootPanel } = useAppStore.getState();
      const leaves = getAllLeaves(rootPanel);
      expect(leaves[0].tabs).toHaveLength(0);

      addTab("SSH - pi.local", "ssh");

      const updatedLeaves = getAllLeaves(useAppStore.getState().rootPanel);
      expect(updatedLeaves[0].tabs).toHaveLength(1);
      expect(updatedLeaves[0].tabs[0].title).toBe("SSH - pi.local");
    });

    it("tab has the correct connection type", () => {
      useAppStore.getState().addTab("Local Shell", "local");

      const leaves = getAllLeaves(useAppStore.getState().rootPanel);
      const tab = leaves[0].tabs[0];
      expect(tab.connectionType).toBe("local");
    });

    it("multiple calls add multiple tabs", () => {
      useAppStore.getState().addTab("Tab 1", "local");
      useAppStore.getState().addTab("Tab 2", "local");
      useAppStore.getState().addTab("Tab 3", "ssh");

      const leaves = getAllLeaves(useAppStore.getState().rootPanel);
      expect(leaves[0].tabs).toHaveLength(3);
    });
  });

  describe("closeTerminal (closeTab)", () => {
    it("removes the specified tab from the panel", () => {
      const { addTab } = useAppStore.getState();
      addTab("To Close", "local");

      const leaves1 = getAllLeaves(useAppStore.getState().rootPanel);
      const tabId = leaves1[0].tabs[0].id;
      const panelId = leaves1[0].id;

      useAppStore.getState().closeTab(tabId, panelId);

      const leaves2 = getAllLeaves(useAppStore.getState().rootPanel);
      expect(leaves2[0].tabs).toHaveLength(0);
    });

    it("does not affect other tabs when closing one", () => {
      useAppStore.getState().addTab("Keep", "local");
      useAppStore.getState().addTab("Close", "local");

      const leaves = getAllLeaves(useAppStore.getState().rootPanel);
      const closeTab = leaves[0].tabs[1];

      useAppStore.getState().closeTab(closeTab.id, leaves[0].id);

      const remaining = getAllLeaves(useAppStore.getState().rootPanel);
      expect(remaining[0].tabs).toHaveLength(1);
      expect(remaining[0].tabs[0].title).toBe("Keep");
    });
  });

  describe("activateTerminal (setActiveTab)", () => {
    it("sets the active tab in the panel", () => {
      useAppStore.getState().addTab("Tab A", "local");
      useAppStore.getState().addTab("Tab B", "local");

      const leaves = getAllLeaves(useAppStore.getState().rootPanel);
      const tabA = leaves[0].tabs[0];
      const tabB = leaves[0].tabs[1];

      // Tab B is active by default (last added)
      expect(leaves[0].activeTabId).toBe(tabB.id);

      useAppStore.getState().setActiveTab(tabA.id, leaves[0].id);

      const updatedLeaves = getAllLeaves(useAppStore.getState().rootPanel);
      expect(updatedLeaves[0].activeTabId).toBe(tabA.id);
    });
  });
});
