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
import { getAllLeaves } from "@/utils/panelTree";

describe("tab groups", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
  });

  describe("initial state", () => {
    it("starts with one tab group named 'Main'", () => {
      const { tabGroups } = useAppStore.getState();
      expect(tabGroups).toHaveLength(1);
      expect(tabGroups[0].name).toBe("Main");
    });

    it("activeTabGroupId matches the initial group", () => {
      const { tabGroups, activeTabGroupId } = useAppStore.getState();
      expect(activeTabGroupId).toBe(tabGroups[0].id);
    });

    it("rootPanel matches the initial group's rootPanel", () => {
      const { tabGroups, rootPanel, activeTabGroupId } = useAppStore.getState();
      const active = tabGroups.find((g) => g.id === activeTabGroupId)!;
      expect(rootPanel).toBe(active.rootPanel);
    });
  });

  describe("addTabGroup", () => {
    it("creates a new group and switches to it", () => {
      useAppStore.getState().addTabGroup("Deploy");
      const { tabGroups, activeTabGroupId } = useAppStore.getState();
      expect(tabGroups).toHaveLength(2);
      const newGroup = tabGroups.find((g) => g.id === activeTabGroupId)!;
      expect(newGroup.name).toBe("Deploy");
    });

    it("auto-names groups when no name is provided", () => {
      useAppStore.getState().addTabGroup();
      const { tabGroups } = useAppStore.getState();
      expect(tabGroups[1].name).toMatch(/Group/);
    });

    it("new group has an empty leaf panel", () => {
      useAppStore.getState().addTabGroup("SSH");
      const { rootPanel } = useAppStore.getState();
      expect(rootPanel.type).toBe("leaf");
      expect((rootPanel as import("@/types/terminal").LeafPanel).tabs).toHaveLength(0);
    });

    it("returns the new group id", () => {
      const id = useAppStore.getState().addTabGroup("Test");
      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(0);
      expect(useAppStore.getState().activeTabGroupId).toBe(id);
    });
  });

  describe("setActiveTabGroup", () => {
    it("switches active group and restores its rootPanel", () => {
      const firstGroupId = useAppStore.getState().activeTabGroupId;
      const { rootPanel: firstRoot } = useAppStore.getState();

      useAppStore.getState().addTabGroup("Second");

      // Switch back to first group
      useAppStore.getState().setActiveTabGroup(firstGroupId);
      const { rootPanel, activeTabGroupId } = useAppStore.getState();

      expect(activeTabGroupId).toBe(firstGroupId);
      expect(rootPanel).toBe(firstRoot);
    });

    it("is a no-op when switching to the already active group", () => {
      const before = useAppStore.getState().activeTabGroupId;
      useAppStore.getState().setActiveTabGroup(before);
      expect(useAppStore.getState().activeTabGroupId).toBe(before);
    });

    it("saves activePanelId into the outgoing group", () => {
      const firstGroupId = useAppStore.getState().activeTabGroupId;
      const firstPanelId = useAppStore.getState().activePanelId;

      useAppStore.getState().addTabGroup("Second");
      useAppStore.getState().setActiveTabGroup(firstGroupId);

      const { tabGroups } = useAppStore.getState();
      const firstGroup = tabGroups.find((g) => g.id === firstGroupId)!;
      // After switching back, the first group's activePanelId should be set
      expect(firstGroup.activePanelId).toBe(firstPanelId);
    });
  });

  describe("closeTabGroup", () => {
    it("removes the specified group", () => {
      useAppStore.getState().addTabGroup("Second");
      const { tabGroups } = useAppStore.getState();
      const secondId = tabGroups[1].id;

      useAppStore.getState().closeTabGroup(secondId);
      expect(useAppStore.getState().tabGroups).toHaveLength(1);
    });

    it("cannot close the last remaining group", () => {
      const { activeTabGroupId } = useAppStore.getState();
      useAppStore.getState().closeTabGroup(activeTabGroupId);
      expect(useAppStore.getState().tabGroups).toHaveLength(1);
    });

    it("switches active group when closing the active one", () => {
      const firstId = useAppStore.getState().activeTabGroupId;
      useAppStore.getState().addTabGroup("Second");
      const secondId = useAppStore.getState().activeTabGroupId;

      // Close second (active) group
      useAppStore.getState().closeTabGroup(secondId);
      expect(useAppStore.getState().activeTabGroupId).toBe(firstId);
    });

    it("keeps active group when closing an inactive one", () => {
      const firstId = useAppStore.getState().activeTabGroupId;
      useAppStore.getState().addTabGroup("Second");
      const secondId = useAppStore.getState().activeTabGroupId;

      // Switch back to first, then close second
      useAppStore.getState().setActiveTabGroup(firstId);
      useAppStore.getState().closeTabGroup(secondId);
      expect(useAppStore.getState().activeTabGroupId).toBe(firstId);
    });
  });

  describe("renameTabGroup", () => {
    it("renames a group", () => {
      const { activeTabGroupId } = useAppStore.getState();
      useAppStore.getState().renameTabGroup(activeTabGroupId, "Renamed");
      const group = useAppStore.getState().tabGroups.find((g) => g.id === activeTabGroupId)!;
      expect(group.name).toBe("Renamed");
    });
  });

  describe("setTabGroupColor", () => {
    it("sets a color on a group", () => {
      const { activeTabGroupId } = useAppStore.getState();
      useAppStore.getState().setTabGroupColor(activeTabGroupId, "#ff0000");
      const group = useAppStore.getState().tabGroups.find((g) => g.id === activeTabGroupId)!;
      expect(group.color).toBe("#ff0000");
    });

    it("clears color when null is passed", () => {
      const { activeTabGroupId } = useAppStore.getState();
      useAppStore.getState().setTabGroupColor(activeTabGroupId, "#ff0000");
      useAppStore.getState().setTabGroupColor(activeTabGroupId, null);
      const group = useAppStore.getState().tabGroups.find((g) => g.id === activeTabGroupId)!;
      expect(group.color).toBeUndefined();
    });
  });

  describe("reorderTabGroups", () => {
    it("moves a group from one position to another", () => {
      useAppStore.getState().addTabGroup("B");
      useAppStore.getState().addTabGroup("C");
      const before = useAppStore.getState().tabGroups.map((g) => g.name);

      // Move group at index 0 to index 2
      useAppStore.getState().reorderTabGroups(0, 2);
      const after = useAppStore.getState().tabGroups.map((g) => g.name);
      expect(after[2]).toBe(before[0]);
    });
  });

  describe("duplicateTabGroup", () => {
    it("creates a new group adjacent to the source and switches to it", () => {
      const firstId = useAppStore.getState().activeTabGroupId;
      useAppStore.getState().duplicateTabGroup(firstId);

      const { tabGroups, activeTabGroupId } = useAppStore.getState();
      expect(tabGroups).toHaveLength(2);
      expect(activeTabGroupId).not.toBe(firstId);
      expect(tabGroups[1].name).toContain("copy");
    });
  });

  describe("rootPanel / tabGroups sync", () => {
    it("tabs added to the active group are reflected in tabGroups", () => {
      useAppStore.getState().addTab("Test", "local");
      const { tabGroups, activeTabGroupId } = useAppStore.getState();
      const activeGroup = tabGroups.find((g) => g.id === activeTabGroupId)!;
      const leaves = getAllLeaves(activeGroup.rootPanel);
      const tabs = leaves.flatMap((l) => l.tabs);
      expect(tabs.some((t) => t.title === "Test")).toBe(true);
    });

    it("tabs in inactive groups are preserved when switching groups", () => {
      // Add a tab to first group
      useAppStore.getState().addTab("InFirst", "local");
      const firstGroupId = useAppStore.getState().activeTabGroupId;

      // Switch to a new group
      useAppStore.getState().addTabGroup("Second");

      // Switch back to first group
      useAppStore.getState().setActiveTabGroup(firstGroupId);

      const { tabGroups } = useAppStore.getState();
      const firstGroup = tabGroups.find((g) => g.id === firstGroupId)!;
      const leaves = getAllLeaves(firstGroup.rootPanel);
      expect(leaves.flatMap((l) => l.tabs).some((t) => t.title === "InFirst")).toBe(true);
    });
  });

  describe("getAllPanels", () => {
    it("returns panels from all tab groups", () => {
      useAppStore.getState().addTabGroup("Second");
      const panels = useAppStore.getState().getAllPanels();
      // One panel from each group (both start with one leaf)
      expect(panels.length).toBeGreaterThanOrEqual(2);
    });
  });
});
