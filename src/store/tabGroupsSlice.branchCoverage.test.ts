/**
 * Branch coverage for the tab-groups slice (#2979): the zoom-follow on a group
 * switch, the empty-source-panel pruning shared by the cross-group / new-group /
 * new-window moves, the hand-off failure path, the optional hand-off fields a
 * destination window hydrates, and the pending-window-restore guards.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

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

const { openWindow, sendHandoffToWindow, takePendingWindowRestore, frontendLog } = vi.hoisted(
  () => ({
    openWindow: vi.fn(),
    sendHandoffToWindow: vi.fn(),
    takePendingWindowRestore: vi.fn(),
    frontendLog: vi.fn(),
  })
);

vi.mock("@/services/api", () => ({
  sftpOpen: vi.fn(),
  sftpClose: vi.fn(),
  sftpListDir: vi.fn(),
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
  openWindow: (...args: unknown[]) => openWindow(...args),
  sendHandoffToWindow: (...args: unknown[]) => sendHandoffToWindow(...args),
  takePendingWindowRestore: (...args: unknown[]) => takePendingWindowRestore(...args),
}));

vi.mock("@/utils/frontendLog", () => ({
  frontendLog: (...args: unknown[]) => frontendLog(...args),
}));

import { useAppStore } from "./appStore";
import { EMPTY_AGENTS_VIEW, setAgentsViewForTest } from "./agentsBridge";
import { getAllLeaves } from "@/utils/panelTree";
import { layoutState } from "@/test/layoutState";
import type { TabHandoffRecord } from "@/types/window";
import type { RemoteAgentDefinition } from "@/types/connection";

/** Add a tab to the active panel and return its id + the panel it landed in. */
function addLocalTab(title = "bash"): { tabId: string; panelId: string } {
  useAppStore.getState().addTab(title, "local");
  const { activePanelId, rootPanel } = layoutState();
  const leaf = getAllLeaves(rootPanel).find((l) => l.id === activePanelId)!;
  return { tabId: leaf.activeTabId!, panelId: leaf.id };
}

/**
 * Two side-by-side panels: `left` holds tab A, `right` (active) holds tab B.
 * Moving B out empties `right`, which must then be pruned from the tree.
 */
function seedSplitWithTabInRightPanel() {
  const left = addLocalTab("A");
  useAppStore.getState().splitPanel("horizontal");
  const right = addLocalTab("B");
  expect(right.panelId).not.toBe(left.panelId);
  expect(getAllLeaves(layoutState().rootPanel)).toHaveLength(2);
  return { left, right };
}

function allTabs() {
  return getAllLeaves(layoutState().rootPanel).flatMap((l) => l.tabs);
}

describe("tabGroupsSlice — branch coverage (#2979)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    openWindow.mockReset().mockResolvedValue("win-1");
    sendHandoffToWindow.mockReset().mockResolvedValue(undefined);
    takePendingWindowRestore.mockReset().mockResolvedValue(null);
    frontendLog.mockReset();
  });

  afterEach(() => {
    setAgentsViewForTest(EMPTY_AGENTS_VIEW);
  });

  describe("setActiveTabGroup — zoom follows the group switch", () => {
    it("moves the zoom to the target group's active tab", () => {
      const firstGroupId = layoutState().activeTabGroupId;
      const a = addLocalTab("A");
      useAppStore.getState().addTabGroup("Second");
      const b = addLocalTab("B");
      useAppStore.getState().setZoomedTabId(b.tabId);

      useAppStore.getState().setActiveTabGroup(firstGroupId);

      expect(layoutState().activeTabGroupId).toBe(firstGroupId);
      expect(useAppStore.getState().zoomedTabId).toBe(a.tabId);
    });

    it("clears the zoom when the target group has no active tab", () => {
      const firstGroupId = layoutState().activeTabGroupId;
      const emptyGroupId = useAppStore.getState().addTabGroup("Empty");
      useAppStore.getState().setActiveTabGroup(firstGroupId);
      const a = addLocalTab("A");
      useAppStore.getState().setZoomedTabId(a.tabId);

      useAppStore.getState().setActiveTabGroup(emptyGroupId);

      expect(useAppStore.getState().zoomedTabId).toBeNull();
    });

    it("leaves an un-zoomed layout un-zoomed", () => {
      const firstGroupId = layoutState().activeTabGroupId;
      addLocalTab("A");
      useAppStore.getState().addTabGroup();
      useAppStore.getState().setActiveTabGroup(firstGroupId);
      expect(useAppStore.getState().zoomedTabId).toBeNull();
    });

    it("ignores an unknown group id", () => {
      const before = layoutState().activeTabGroupId;
      useAppStore.getState().setActiveTabGroup("no-such-group");
      expect(layoutState().activeTabGroupId).toBe(before);
    });
  });

  describe("moveTabToGroup", () => {
    it("prunes the emptied source panel and re-points the active panel", () => {
      const firstGroupId = layoutState().activeTabGroupId;
      const targetGroupId = useAppStore.getState().addTabGroup("Target");
      useAppStore.getState().setActiveTabGroup(firstGroupId);
      const { left, right } = seedSplitWithTabInRightPanel();
      expect(layoutState().activePanelId).toBe(right.panelId);

      useAppStore.getState().moveTabToGroup(right.tabId, right.panelId, targetGroupId);

      const leaves = getAllLeaves(layoutState().rootPanel);
      expect(leaves.map((l) => l.id)).toEqual([left.panelId]);
      expect(layoutState().activePanelId).toBe(left.panelId);
      const target = layoutState().tabGroups.find((g) => g.id === targetGroupId)!;
      const moved = getAllLeaves(target.rootPanel).flatMap((l) => l.tabs);
      expect(moved.map((t) => t.id)).toEqual([right.tabId]);
      expect(moved[0].isActive).toBe(true);
    });

    it("keeps the active panel when the tab moves out of a non-active panel", () => {
      const firstGroupId = layoutState().activeTabGroupId;
      const targetGroupId = useAppStore.getState().addTabGroup("Target");
      useAppStore.getState().setActiveTabGroup(firstGroupId);
      const { left, right } = seedSplitWithTabInRightPanel();
      useAppStore.getState().setActivePanel(left.panelId);

      useAppStore.getState().moveTabToGroup(right.tabId, right.panelId, targetGroupId);

      expect(layoutState().activePanelId).toBe(left.panelId);
    });

    it("deactivates the target panel's existing tabs when the moved tab lands", () => {
      const firstGroupId = layoutState().activeTabGroupId;
      const targetGroupId = useAppStore.getState().addTabGroup("Target");
      const existing = addLocalTab("existing");
      useAppStore.getState().setActiveTabGroup(firstGroupId);
      const a = addLocalTab("A");
      addLocalTab("A2");

      useAppStore.getState().moveTabToGroup(a.tabId, a.panelId, targetGroupId);

      const target = layoutState().tabGroups.find((g) => g.id === targetGroupId)!;
      const leaf = getAllLeaves(target.rootPanel)[0];
      expect(leaf.tabs.map((t) => t.id)).toEqual([existing.tabId, a.tabId]);
      expect(leaf.activeTabId).toBe(a.tabId);
    });

    it("is a no-op for an unknown source panel, tab or target group", () => {
      const firstGroupId = layoutState().activeTabGroupId;
      const targetGroupId = useAppStore.getState().addTabGroup("Target");
      useAppStore.getState().setActiveTabGroup(firstGroupId);
      const a = addLocalTab("A");

      useAppStore.getState().moveTabToGroup(a.tabId, "no-such-panel", targetGroupId);
      useAppStore.getState().moveTabToGroup("no-such-tab", a.panelId, targetGroupId);
      useAppStore.getState().moveTabToGroup(a.tabId, a.panelId, "no-such-group");

      expect(allTabs().map((t) => t.id)).toEqual([a.tabId]);
    });
  });

  describe("addTabGroupWithTab", () => {
    it("prunes the emptied source panel in the saved source group", () => {
      const sourceGroupId = layoutState().activeTabGroupId;
      const { left, right } = seedSplitWithTabInRightPanel();

      useAppStore.getState().addTabGroupWithTab(right.tabId, right.panelId);

      const source = layoutState().tabGroups.find((g) => g.id === sourceGroupId)!;
      expect(getAllLeaves(source.rootPanel).map((l) => l.id)).toEqual([left.panelId]);
      expect(source.activePanelId).toBe(left.panelId);
      expect(allTabs().map((t) => t.id)).toEqual([right.tabId]);
      expect(layoutState().tabGroups.at(-1)!.name).toBe("Group 2");
    });

    it("keeps the source group's active panel when moving from a non-active panel", () => {
      const sourceGroupId = layoutState().activeTabGroupId;
      const { left, right } = seedSplitWithTabInRightPanel();
      useAppStore.getState().setActivePanel(left.panelId);

      useAppStore.getState().addTabGroupWithTab(right.tabId, right.panelId);

      const source = layoutState().tabGroups.find((g) => g.id === sourceGroupId)!;
      expect(source.activePanelId).toBe(left.panelId);
    });

    it("is a no-op for an unknown source panel", () => {
      const a = addLocalTab("A");
      useAppStore.getState().addTabGroupWithTab(a.tabId, "no-such-panel");
      expect(layoutState().tabGroups).toHaveLength(1);
    });
  });

  describe("moveTabToWindow", () => {
    it("clears the moving flag and keeps the tab when the hand-off fails", async () => {
      const a = addLocalTab("A");
      useAppStore.getState().setTabSessionId(a.tabId, "sess-fail");
      openWindow.mockRejectedValueOnce(new Error("no window"));

      await useAppStore.getState().moveTabToWindow(a.tabId, a.panelId, { kind: "new" });

      expect(useAppStore.getState().isSessionMoving("sess-fail")).toBe(false);
      expect(allTabs().map((t) => t.id)).toEqual([a.tabId]);
      expect(frontendLog).toHaveBeenCalledWith(
        "multi_window",
        expect.stringContaining("move tab to window failed")
      );
    });

    it("keeps a session-less tab on hand-off failure without touching moving ids", async () => {
      const a = addLocalTab("A");
      sendHandoffToWindow.mockRejectedValueOnce("gone");

      await useAppStore
        .getState()
        .moveTabToWindow(a.tabId, a.panelId, { kind: "existing", label: "win-2" });

      expect(useAppStore.getState().movingSessionIds).toEqual([]);
      expect(allTabs().map((t) => t.id)).toEqual([a.tabId]);
    });

    it("moves a session-less tab without marking anything as moving", async () => {
      const a = addLocalTab("A");

      await useAppStore.getState().moveTabToWindow(a.tabId, a.panelId, { kind: "new" });

      expect(openWindow).toHaveBeenCalledTimes(1);
      expect(useAppStore.getState().movingSessionIds).toEqual([]);
      expect(allTabs()).toHaveLength(0);
    });

    it("does not duplicate an already-moving session id", async () => {
      const a = addLocalTab("A");
      useAppStore.getState().setTabSessionId(a.tabId, "sess-dup");
      useAppStore.setState({ movingSessionIds: ["sess-dup"] });

      await useAppStore.getState().moveTabToWindow(a.tabId, a.panelId, { kind: "new" });

      expect(useAppStore.getState().movingSessionIds).toEqual(["sess-dup"]);
    });

    it("prunes the emptied source panel and re-points the active panel", async () => {
      const { left, right } = seedSplitWithTabInRightPanel();

      await useAppStore.getState().moveTabToWindow(right.tabId, right.panelId, { kind: "new" });

      expect(getAllLeaves(layoutState().rootPanel).map((l) => l.id)).toEqual([left.panelId]);
      expect(layoutState().activePanelId).toBe(left.panelId);
    });

    it("keeps the active panel when moving out of a non-active panel", async () => {
      const { left, right } = seedSplitWithTabInRightPanel();
      useAppStore.getState().setActivePanel(left.panelId);

      await useAppStore.getState().moveTabToWindow(right.tabId, right.panelId, { kind: "new" });

      expect(layoutState().activePanelId).toBe(left.panelId);
    });
  });

  describe("hydrateHandoffTab", () => {
    it("carries every optional hand-off field and un-releases the session", () => {
      const existing = addLocalTab("existing");
      useAppStore.setState({ releasedTransferSessions: ["sess-h", "sess-other"] });
      const record: TabHandoffRecord = {
        tab: {
          sessionId: "sess-h",
          title: "moved",
          connectionType: "local",
          contentType: "terminal",
          config: { type: "local", config: {} },
          initialCommand: "ls -la",
          persistentConnectionId: "pc-1",
          connectionId: "conn-1",
          spawned: true,
        },
      };

      useAppStore.getState().hydrateHandoffTab(record);

      const leaf = getAllLeaves(layoutState().rootPanel)[0];
      expect(leaf.tabs).toHaveLength(2);
      const tab = leaf.tabs[1];
      expect(leaf.activeTabId).toBe(tab.id);
      expect(leaf.tabs.find((t) => t.id === existing.tabId)!.isActive).toBe(false);
      expect(tab).toMatchObject({
        sessionId: "sess-h",
        initialCommand: "ls -la",
        persistentConnectionId: "pc-1",
        connectionId: "conn-1",
        spawned: true,
        pendingScrollbackReplay: true,
      });
      expect(useAppStore.getState().releasedTransferSessions).toEqual(["sess-other"]);
    });

    it("omits the optional fields and replay flag for a session-less hand-off", () => {
      useAppStore.setState({ releasedTransferSessions: ["sess-keep"] });
      const record: TabHandoffRecord = {
        tab: {
          sessionId: null,
          title: "plain",
          connectionType: "local",
          contentType: "terminal",
          config: { type: "local", config: {} },
        },
      };

      useAppStore.getState().hydrateHandoffTab(record);

      const [tab] = allTabs();
      expect(tab.title).toBe("plain");
      expect(tab).not.toHaveProperty("initialCommand");
      expect(tab).not.toHaveProperty("persistentConnectionId");
      expect(tab).not.toHaveProperty("connectionId");
      expect(tab).not.toHaveProperty("spawned");
      expect(tab).not.toHaveProperty("pendingScrollbackReplay");
      expect(useAppStore.getState().releasedTransferSessions).toEqual(["sess-keep"]);
    });
  });

  describe("receivePendingWindowRestore", () => {
    it("logs and bails when draining the pending restore fails", async () => {
      takePendingWindowRestore.mockRejectedValueOnce(new Error("ipc down"));
      const before = layoutState().tabGroups;

      await useAppStore.getState().receivePendingWindowRestore();

      expect(layoutState().tabGroups).toBe(before);
      expect(frontendLog).toHaveBeenCalledWith(
        "multi_window",
        expect.stringContaining("takePendingWindowRestore failed")
      );
    });

    it("is a no-op for a payload with no groups", async () => {
      takePendingWindowRestore.mockResolvedValueOnce({ tabGroups: [] });
      const before = layoutState().tabGroups;

      await useAppStore.getState().receivePendingWindowRestore();

      expect(layoutState().tabGroups).toBe(before);
    });

    it("refuses a payload whose groups produce no launchable tabs", async () => {
      takePendingWindowRestore.mockResolvedValueOnce({
        tabGroups: [{ name: "Empty", layout: { type: "leaf", tabs: [] } }],
      });
      const before = layoutState().tabGroups;

      await useAppStore.getState().receivePendingWindowRestore();

      expect(layoutState().tabGroups).toBe(before);
      expect(frontendLog).toHaveBeenCalledWith(
        "multi_window",
        expect.stringContaining("no launchable tabs")
      );
    });

    it("resolves agentRef tabs against the projected agents", async () => {
      const agent = {
        id: "ag-1",
        name: "Build box",
        connectionState: "connected",
      } as RemoteAgentDefinition;
      setAgentsViewForTest({
        ...EMPTY_AGENTS_VIEW,
        remoteAgents: [agent],
        agentDefinitions: {
          "ag-1": [
            {
              id: "def-1",
              name: "Shell",
              sessionType: "shell",
              config: { shell: "bash" },
              persistent: false,
              folderId: null,
            },
          ],
        },
      });
      takePendingWindowRestore.mockResolvedValueOnce({
        tabGroups: [
          {
            name: "Agents",
            layout: {
              type: "leaf",
              tabs: [
                { agentRef: { agentId: "ag-1", definitionId: "def-1" } },
                { agentRef: { agentId: "ag-1", definitionId: "missing" }, title: "Gone" },
              ],
            },
          },
        ],
      });

      await useAppStore.getState().receivePendingWindowRestore();

      expect(layoutState().tabGroups.map((g) => g.name)).toEqual(["Agents"]);
      const tabs = allTabs();
      expect(tabs.map((t) => t.contentType)).toEqual(["terminal", "agent-error"]);
      expect(tabs[0].title).toBe("Shell");
    });
  });
});
