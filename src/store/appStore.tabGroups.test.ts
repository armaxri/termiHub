import { describe, it, expect, beforeEach, vi } from "vitest";

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

vi.mock("@/services/api", () => ({
  sftpOpen: vi.fn(),
  sftpClose: vi.fn(),
  sftpListDir: vi.fn(),
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
}));

import { useAppStore } from "./appStore";
import { getAllLeaves } from "@/utils/panelTree";

describe("appStore — tab groups", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
  });

  describe("initial state", () => {
    it("starts with one tab group named Main", () => {
      const { tabGroups } = useAppStore.getState();
      expect(tabGroups).toHaveLength(1);
      expect(tabGroups[0].name).toBe("Main");
    });

    it("activeTabGroupId matches the only group", () => {
      const { tabGroups, activeTabGroupId } = useAppStore.getState();
      expect(activeTabGroupId).toBe(tabGroups[0].id);
    });

    it("rootPanel matches the initial group's rootPanel", () => {
      const { tabGroups, activeTabGroupId, rootPanel } = useAppStore.getState();
      const activeGroup = tabGroups.find((g) => g.id === activeTabGroupId)!;
      expect(rootPanel.id).toBe(activeGroup.rootPanel.id);
    });
  });

  describe("addTabGroup", () => {
    it("creates a new group and returns its ID", () => {
      const newId = useAppStore.getState().addTabGroup();
      const { tabGroups } = useAppStore.getState();
      expect(tabGroups).toHaveLength(2);
      expect(tabGroups[1].id).toBe(newId);
    });

    it("auto-names the group when no name is provided", () => {
      useAppStore.getState().addTabGroup();
      const { tabGroups } = useAppStore.getState();
      expect(tabGroups[1].name).toBe("Group 2");
    });

    it("uses the provided name", () => {
      useAppStore.getState().addTabGroup("Deploy");
      const { tabGroups } = useAppStore.getState();
      expect(tabGroups[1].name).toBe("Deploy");
    });

    it("switches to the new group", () => {
      const newId = useAppStore.getState().addTabGroup();
      expect(useAppStore.getState().activeTabGroupId).toBe(newId);
    });

    it("new group starts with an empty panel tree", () => {
      useAppStore.getState().addTabGroup();
      const { rootPanel } = useAppStore.getState();
      expect(rootPanel.type).toBe("leaf");
      expect(getAllLeaves(rootPanel)[0].tabs).toHaveLength(0);
    });

    it("saves previous group rootPanel into tabGroups before switching", () => {
      // Add a tab to the initial group
      useAppStore.getState().addTab("bash", "local");
      const initialRootId = useAppStore.getState().rootPanel.id;

      // Create a new group (should save current rootPanel into tabGroups[0])
      useAppStore.getState().addTabGroup();

      const { tabGroups } = useAppStore.getState();
      const savedGroup = tabGroups[0];
      expect(savedGroup.rootPanel.id).toBe(initialRootId);
      expect(getAllLeaves(savedGroup.rootPanel)[0].tabs).toHaveLength(1);
    });
  });

  describe("setActiveTabGroup", () => {
    it("switches to the specified group", () => {
      const firstId = useAppStore.getState().tabGroups[0].id;
      useAppStore.getState().addTabGroup();
      useAppStore.getState().setActiveTabGroup(firstId);
      expect(useAppStore.getState().activeTabGroupId).toBe(firstId);
    });

    it("restores rootPanel and activePanelId of the target group", () => {
      const firstGroupRootId = useAppStore.getState().rootPanel.id;
      const firstGroupId = useAppStore.getState().tabGroups[0].id;

      useAppStore.getState().addTabGroup(); // now active is group 2
      expect(useAppStore.getState().rootPanel.id).not.toBe(firstGroupRootId);

      useAppStore.getState().setActiveTabGroup(firstGroupId);
      expect(useAppStore.getState().rootPanel.id).toBe(firstGroupRootId);
    });

    it("saves current rootPanel into tabGroups before switching away", () => {
      const initialGroupId = useAppStore.getState().tabGroups[0].id;
      useAppStore.getState().addTabGroup();
      useAppStore.getState().addTab("bash", "local");
      const activeRootBeforeSwitch = useAppStore.getState().rootPanel;

      useAppStore.getState().setActiveTabGroup(initialGroupId);

      const { tabGroups } = useAppStore.getState();
      const savedGroup = tabGroups.find((g) => g.id !== initialGroupId)!;
      expect(savedGroup.rootPanel.id).toBe(activeRootBeforeSwitch.id);
    });

    it("is a no-op when switching to the already active group", () => {
      const { activeTabGroupId, tabGroups } = useAppStore.getState();
      const rootId = useAppStore.getState().rootPanel.id;
      useAppStore.getState().setActiveTabGroup(activeTabGroupId);
      expect(useAppStore.getState().rootPanel.id).toBe(rootId);
      expect(useAppStore.getState().tabGroups).toEqual(tabGroups);
    });
  });

  describe("closeTabGroup", () => {
    it("does nothing when only one group exists", () => {
      const { tabGroups } = useAppStore.getState();
      useAppStore.getState().closeTabGroup(tabGroups[0].id);
      expect(useAppStore.getState().tabGroups).toHaveLength(1);
    });

    it("removes the specified group", () => {
      useAppStore.getState().addTabGroup();
      const { tabGroups } = useAppStore.getState();
      const firstId = tabGroups[0].id;
      useAppStore.getState().closeTabGroup(firstId);
      expect(useAppStore.getState().tabGroups).toHaveLength(1);
      expect(useAppStore.getState().tabGroups[0].id).not.toBe(firstId);
    });

    it("closes an inactive group without switching active group", () => {
      useAppStore.getState().addTabGroup();
      const { tabGroups, activeTabGroupId } = useAppStore.getState();
      const inactiveId = tabGroups.find((g) => g.id !== activeTabGroupId)!.id;
      useAppStore.getState().closeTabGroup(inactiveId);
      expect(useAppStore.getState().activeTabGroupId).toBe(activeTabGroupId);
    });

    it("switches to adjacent group when closing the active group", () => {
      useAppStore.getState().addTabGroup("B");
      const { tabGroups } = useAppStore.getState();
      const secondId = tabGroups[1].id;
      // Currently active is group B (index 1); close it → should fall back to group A (index 0)
      useAppStore.getState().closeTabGroup(secondId);
      expect(useAppStore.getState().activeTabGroupId).toBe(tabGroups[0].id);
    });

    it("updates rootPanel after closing the active group", () => {
      const firstRootId = useAppStore.getState().rootPanel.id;
      const newId = useAppStore.getState().addTabGroup();
      // Active is now new group with different rootPanel
      useAppStore.getState().closeTabGroup(newId);
      // Should restore first group's rootPanel
      expect(useAppStore.getState().rootPanel.id).toBe(firstRootId);
    });
  });

  describe("renameTabGroup", () => {
    it("renames the specified group", () => {
      const { tabGroups } = useAppStore.getState();
      useAppStore.getState().renameTabGroup(tabGroups[0].id, "Dev");
      expect(useAppStore.getState().tabGroups[0].name).toBe("Dev");
    });

    it("does not affect other groups", () => {
      useAppStore.getState().addTabGroup("B");
      const { tabGroups } = useAppStore.getState();
      useAppStore.getState().renameTabGroup(tabGroups[0].id, "Renamed");
      expect(useAppStore.getState().tabGroups[1].name).toBe("B");
    });
  });

  describe("setTabGroupColor", () => {
    it("sets the accent color on the specified group", () => {
      const { tabGroups } = useAppStore.getState();
      useAppStore.getState().setTabGroupColor(tabGroups[0].id, "#ff0000");
      expect(useAppStore.getState().tabGroups[0].color).toBe("#ff0000");
    });

    it("clears the color when null is passed", () => {
      const { tabGroups } = useAppStore.getState();
      useAppStore.getState().setTabGroupColor(tabGroups[0].id, "#ff0000");
      useAppStore.getState().setTabGroupColor(tabGroups[0].id, null);
      expect(useAppStore.getState().tabGroups[0].color).toBeUndefined();
    });
  });

  describe("reorderTabGroups", () => {
    it("moves a group to a new index", () => {
      useAppStore.getState().addTabGroup("B");
      useAppStore.getState().addTabGroup("C");
      const names = () => useAppStore.getState().tabGroups.map((g) => g.name);
      expect(names()).toEqual(["Main", "B", "C"]);
      useAppStore.getState().reorderTabGroups(0, 2);
      expect(names()).toEqual(["B", "C", "Main"]);
    });

    it("moving to same index is a no-op", () => {
      useAppStore.getState().addTabGroup("B");
      const before = useAppStore.getState().tabGroups.map((g) => g.id);
      useAppStore.getState().reorderTabGroups(0, 0);
      const after = useAppStore.getState().tabGroups.map((g) => g.id);
      expect(after).toEqual(before);
    });
  });

  describe("moveTabToGroup", () => {
    it("moves a tab from the active group to a target group", () => {
      // Set up: add a tab to the initial group
      useAppStore.getState().addTab("bash", "local");
      const group1Id = useAppStore.getState().tabGroups[0].id;
      const group1Leaf = getAllLeaves(useAppStore.getState().rootPanel)[0];
      const tabId = group1Leaf.tabs[0].id;
      const panelId = group1Leaf.id;

      // Create a second group
      const group2Id = useAppStore.getState().addTabGroup("Group 2");
      // Switch back to group 1 so it's active
      useAppStore.getState().setActiveTabGroup(group1Id);

      // Move the tab to group 2
      useAppStore.getState().moveTabToGroup(tabId, panelId, group2Id);

      // Tab should be gone from active group
      const activeTabs = getAllLeaves(useAppStore.getState().rootPanel).flatMap((l) => l.tabs);
      expect(activeTabs).toHaveLength(0);

      // Tab should be in group 2's saved rootPanel
      const { tabGroups } = useAppStore.getState();
      const group2 = tabGroups.find((g) => g.id === group2Id)!;
      const group2Tabs = getAllLeaves(group2.rootPanel).flatMap((l) => l.tabs);
      expect(group2Tabs).toHaveLength(1);
      expect(group2Tabs[0].id).toBe(tabId);
    });

    it("is a no-op when target group is the active group", () => {
      useAppStore.getState().addTab("bash", "local");
      const { activeTabGroupId, rootPanel } = useAppStore.getState();
      const leaf = getAllLeaves(rootPanel)[0];
      const tabId = leaf.tabs[0].id;
      const before = useAppStore.getState().rootPanel;

      useAppStore.getState().moveTabToGroup(tabId, leaf.id, activeTabGroupId);

      expect(useAppStore.getState().rootPanel).toBe(before);
    });

    it("does not switch the active group", () => {
      useAppStore.getState().addTab("bash", "local");
      const group1Id = useAppStore.getState().tabGroups[0].id;
      const leaf = getAllLeaves(useAppStore.getState().rootPanel)[0];
      const tabId = leaf.tabs[0].id;
      const group2Id = useAppStore.getState().addTabGroup("Group 2");
      useAppStore.getState().setActiveTabGroup(group1Id);

      useAppStore.getState().moveTabToGroup(tabId, leaf.id, group2Id);

      expect(useAppStore.getState().activeTabGroupId).toBe(group1Id);
    });

    it("updates panelId of the moved tab to the target group's first leaf", () => {
      useAppStore.getState().addTab("bash", "local");
      const group1Id = useAppStore.getState().tabGroups[0].id;
      const leaf = getAllLeaves(useAppStore.getState().rootPanel)[0];
      const tabId = leaf.tabs[0].id;
      const group2Id = useAppStore.getState().addTabGroup("Group 2");
      const group2Leaf = getAllLeaves(useAppStore.getState().rootPanel)[0];
      useAppStore.getState().setActiveTabGroup(group1Id);

      useAppStore.getState().moveTabToGroup(tabId, leaf.id, group2Id);

      const { tabGroups } = useAppStore.getState();
      const group2 = tabGroups.find((g) => g.id === group2Id)!;
      const movedTab = getAllLeaves(group2.rootPanel).flatMap((l) => l.tabs)[0];
      expect(movedTab.panelId).toBe(group2Leaf.id);
    });
  });

  describe("session preservation across group switches", () => {
    it("tabs added to one group are not visible when switching to another", () => {
      // Add tabs to group 1
      useAppStore.getState().addTab("bash", "local");
      useAppStore.getState().addTab("zsh", "local");
      const group1Tabs = getAllLeaves(useAppStore.getState().rootPanel).flatMap((l) => l.tabs);
      expect(group1Tabs).toHaveLength(2);

      // Switch to a new group
      useAppStore.getState().addTabGroup("group2");
      const group2Tabs = getAllLeaves(useAppStore.getState().rootPanel).flatMap((l) => l.tabs);
      expect(group2Tabs).toHaveLength(0);
    });

    it("tabs are restored when switching back to a group", () => {
      useAppStore.getState().addTab("bash", "local");
      const group1Id = useAppStore.getState().tabGroups[0].id;

      useAppStore.getState().addTabGroup("group2");
      useAppStore.getState().setActiveTabGroup(group1Id);

      const tabs = getAllLeaves(useAppStore.getState().rootPanel).flatMap((l) => l.tabs);
      expect(tabs).toHaveLength(1);
      expect(tabs[0].title).toBe("bash");
    });
  });
});
