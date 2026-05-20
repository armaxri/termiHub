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

/** Get the active group from current store state. */
function getActiveGroup() {
  const state = useAppStore.getState();
  return state.tabGroups.find((g) => g.id === state.activeTabGroupId)!;
}

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

    it("active group has modelJson", () => {
      const { tabGroups, activeTabGroupId } = useAppStore.getState();
      const activeGroup = tabGroups.find((g) => g.id === activeTabGroupId)!;
      expect(activeGroup.modelJson).toBeDefined();
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

    it("new group starts with empty tabs", () => {
      useAppStore.getState().addTabGroup();
      const activeGroup = getActiveGroup();
      expect(activeGroup.tabs).toHaveLength(0);
    });

    it("saves previous group's tabs into tabGroups before switching", () => {
      // Add a tab to the initial group
      useAppStore.getState().addTab("bash", "local");
      const group1Id = useAppStore.getState().tabGroups[0].id;

      // Create a new group (should preserve tabGroups[0].tabs)
      useAppStore.getState().addTabGroup();

      const { tabGroups } = useAppStore.getState();
      const savedGroup = tabGroups.find((g) => g.id === group1Id)!;
      expect(savedGroup.tabs).toHaveLength(1);
    });
  });

  describe("setActiveTabGroup", () => {
    it("switches to the specified group", () => {
      const firstId = useAppStore.getState().tabGroups[0].id;
      useAppStore.getState().addTabGroup();
      useAppStore.getState().setActiveTabGroup(firstId);
      expect(useAppStore.getState().activeTabGroupId).toBe(firstId);
    });

    it("restores tabs of the target group", () => {
      // Add a tab to first group
      useAppStore.getState().addTab("bash", "local");
      const firstGroupId = useAppStore.getState().tabGroups[0].id;

      // Switch to second group (no tabs)
      useAppStore.getState().addTabGroup();
      expect(getActiveGroup().tabs).toHaveLength(0);

      // Switch back — should restore the tab
      useAppStore.getState().setActiveTabGroup(firstGroupId);
      expect(getActiveGroup().tabs).toHaveLength(1);
    });

    it("saves current group's tabs into tabGroups before switching away", () => {
      const initialGroupId = useAppStore.getState().tabGroups[0].id;
      const secondGroupId = useAppStore.getState().addTabGroup();
      useAppStore.getState().addTab("bash", "local");

      useAppStore.getState().setActiveTabGroup(initialGroupId);

      const { tabGroups } = useAppStore.getState();
      const savedGroup = tabGroups.find((g) => g.id === secondGroupId)!;
      expect(savedGroup.tabs).toHaveLength(1);
    });

    it("is a no-op when switching to the already active group", () => {
      const { activeTabGroupId, tabGroups } = useAppStore.getState();
      useAppStore.getState().setActiveTabGroup(activeTabGroupId);
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

    it("restores adjacent group's modelJson after closing the active group", () => {
      const firstGroupModelJson = useAppStore.getState().tabGroups[0].modelJson;
      const newId = useAppStore.getState().addTabGroup();
      // Active is now new group with different modelJson
      useAppStore.getState().closeTabGroup(newId);
      // Should restore first group's modelJson
      expect(useAppStore.getState().tabGroups[0].modelJson).toEqual(firstGroupModelJson);
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
      const activeGroup = getActiveGroup();
      const tabId = activeGroup.tabs[0].id;

      // Create a second group
      const group2Id = useAppStore.getState().addTabGroup("Group 2");
      // Switch back to group 1 so it's active
      useAppStore.getState().setActiveTabGroup(group1Id);

      // Move the tab to group 2
      useAppStore.getState().moveTabToGroup(tabId, activeGroup.activeTabSetId ?? "", group2Id);

      // Tab should be gone from active group
      const updatedActiveGroup = getActiveGroup();
      expect(updatedActiveGroup.tabs).toHaveLength(0);

      // Tab should be in group 2's saved tabs
      const { tabGroups } = useAppStore.getState();
      const group2 = tabGroups.find((g) => g.id === group2Id)!;
      expect(group2.tabs).toHaveLength(1);
      expect(group2.tabs[0].id).toBe(tabId);
    });

    it("is a no-op when target group is the active group", () => {
      useAppStore.getState().addTab("bash", "local");
      const { activeTabGroupId } = useAppStore.getState();
      const activeGroup = getActiveGroup();
      const tabId = activeGroup.tabs[0].id;
      const tabsBefore = activeGroup.tabs.length;

      useAppStore
        .getState()
        .moveTabToGroup(tabId, activeGroup.activeTabSetId ?? "", activeTabGroupId);

      expect(getActiveGroup().tabs.length).toBe(tabsBefore);
    });

    it("does not switch the active group", () => {
      useAppStore.getState().addTab("bash", "local");
      const group1Id = useAppStore.getState().tabGroups[0].id;
      const activeGroup = getActiveGroup();
      const tabId = activeGroup.tabs[0].id;
      const group2Id = useAppStore.getState().addTabGroup("Group 2");
      useAppStore.getState().setActiveTabGroup(group1Id);

      useAppStore.getState().moveTabToGroup(tabId, activeGroup.activeTabSetId ?? "", group2Id);

      expect(useAppStore.getState().activeTabGroupId).toBe(group1Id);
    });
  });

  describe("addTabGroupWithTab", () => {
    it("creates a new group and moves the tab into it atomically", () => {
      useAppStore.getState().addTab("bash", "local");
      const activeGroup = getActiveGroup();
      const tabId = activeGroup.tabs[0].id;

      useAppStore.getState().addTabGroupWithTab(tabId, activeGroup.activeTabSetId ?? "");

      const state = useAppStore.getState();
      // New group should be active
      expect(state.tabGroups).toHaveLength(2);
      const newGroup = state.tabGroups.find((g) => g.id === state.activeTabGroupId)!;
      expect(newGroup.tabs).toHaveLength(1);
      expect(newGroup.tabs[0].id).toBe(tabId);
    });

    it("removes the tab from the source group", () => {
      useAppStore.getState().addTab("bash", "local");
      useAppStore.getState().addTab("zsh", "local");
      const activeGroup = getActiveGroup();
      const tabId = activeGroup.tabs[0].id;
      const group1Id = useAppStore.getState().tabGroups[0].id;

      useAppStore.getState().addTabGroupWithTab(tabId, activeGroup.activeTabSetId ?? "");

      const state = useAppStore.getState();
      const group1 = state.tabGroups.find((g) => g.id === group1Id)!;
      expect(group1.tabs.every((t) => t.id !== tabId)).toBe(true);
    });

    it("is a no-op when the tab does not exist", () => {
      const before = useAppStore.getState().tabGroups;
      useAppStore.getState().addTabGroupWithTab("nonexistent", "nonexistent");
      expect(useAppStore.getState().tabGroups).toBe(before);
    });
  });

  describe("session preservation across group switches", () => {
    it("tabs added to one group are not visible when switching to another", () => {
      // Add tabs to group 1
      useAppStore.getState().addTab("bash", "local");
      useAppStore.getState().addTab("zsh", "local");
      expect(getActiveGroup().tabs).toHaveLength(2);

      // Switch to a new group
      useAppStore.getState().addTabGroup("group2");
      expect(getActiveGroup().tabs).toHaveLength(0);
    });

    it("tabs are restored when switching back to a group", () => {
      useAppStore.getState().addTab("bash", "local");
      const group1Id = useAppStore.getState().tabGroups[0].id;

      useAppStore.getState().addTabGroup("group2");
      useAppStore.getState().setActiveTabGroup(group1Id);

      const tabs = getActiveGroup().tabs;
      expect(tabs).toHaveLength(1);
      expect(tabs[0].title).toBe("bash");
    });
  });
});
