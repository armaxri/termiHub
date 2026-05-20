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
  attachPersistentTab: vi.fn(() => Promise.resolve(1)),
}));

import { useAppStore, _resetConnectionReloadSeq } from "./appStore";
import * as api from "@/services/api";
import * as storage from "@/services/storage";
import type { AgentDefinitionInfo } from "@/services/api";

/** Flush all pending microtasks so `void promise` side-effects settle. */
function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Get the active group from current store state. */
function getActiveGroup() {
  const state = useAppStore.getState();
  return state.tabGroups.find((g) => g.id === state.activeTabGroupId)!;
}

describe("appStore", () => {
  beforeEach(() => {
    // Reset store state by getting a fresh initial state
    useAppStore.setState(useAppStore.getInitialState());
    // Reset the reload sequencer so sequence numbers don't bleed between tests
    _resetConnectionReloadSeq();
  });

  describe("addTab", () => {
    it("adds a tab to the active group", () => {
      const { addTab } = useAppStore.getState();
      addTab("Test Shell", "local", { type: "local", config: { shell: "zsh" } });

      const activeGroup = getActiveGroup();
      expect(activeGroup.tabs).toHaveLength(1);
      expect(activeGroup.tabs[0].title).toBe("Test Shell");
      expect(activeGroup.activeTabId).toBe(activeGroup.tabs[0].id);
    });

    it("sets new tab as active", () => {
      const { addTab } = useAppStore.getState();
      addTab("Tab 1", "local");
      addTab("Tab 2", "local");

      const activeGroup = getActiveGroup();
      expect(activeGroup.tabs).toHaveLength(2);
      expect(activeGroup.activeTabId).toBe(activeGroup.tabs[1].id);
      expect(activeGroup.tabs[0].isActive).toBe(false);
      expect(activeGroup.tabs[1].isActive).toBe(true);
    });
  });

  describe("addTab with sessionId", () => {
    it("creates a tab with a pre-existing sessionId", () => {
      const { addTab } = useAppStore.getState();
      addTab(
        "Setup: Pi",
        "ssh",
        {
          type: "ssh",
          config: {
            host: "pi.local",
            port: 22,
            username: "pi",
            authMethod: "key",
            enableX11Forwarding: false,
          },
        },
        undefined,
        "terminal",
        undefined,
        "existing-session-123"
      );

      const activeGroup = getActiveGroup();
      expect(activeGroup.tabs).toHaveLength(1);
      expect(activeGroup.tabs[0].sessionId).toBe("existing-session-123");
      expect(activeGroup.tabs[0].title).toBe("Setup: Pi");
    });

    it("defaults sessionId to null when not provided", () => {
      const { addTab } = useAppStore.getState();
      addTab("Terminal", "local");

      const activeGroup = getActiveGroup();
      expect(activeGroup.tabs[0].sessionId).toBeNull();
    });
  });

  describe("closeTab", () => {
    it("removes tab and selects next tab", () => {
      const { addTab } = useAppStore.getState();
      addTab("Tab 1", "local");
      addTab("Tab 2", "local");

      const groupBefore = getActiveGroup();
      const tabToClose = groupBefore.tabs[0].id;
      // closeTab requires a panelId; pass the activeTabSetId as the panel identifier
      useAppStore.getState().closeTab(tabToClose, groupBefore.activeTabSetId ?? "");

      const groupAfter = getActiveGroup();
      expect(groupAfter.tabs).toHaveLength(1);
      expect(groupAfter.tabs[0].title).toBe("Tab 2");
    });
  });

  describe("setActiveTab", () => {
    it("sets the correct tab active", () => {
      const { addTab } = useAppStore.getState();
      addTab("Tab 1", "local");
      addTab("Tab 2", "local");

      const group = getActiveGroup();
      const firstTabId = group.tabs[0].id;
      useAppStore.getState().setActiveTab(firstTabId, group.activeTabSetId ?? "");

      const updated = getActiveGroup();
      expect(updated.activeTabId).toBe(firstTabId);
      expect(updated.tabs[0].isActive).toBe(true);
      expect(updated.tabs[1].isActive).toBe(false);
    });
  });

  describe("splitPanel", () => {
    it("splitPanel smoke test — does not throw without a live model", () => {
      // splitPanel requires a live flexlayout Model registered via registerModel.
      // In unit tests there is no live model, so the call is a no-op; we only
      // verify it does not throw.
      expect(() => useAppStore.getState().splitPanel("horizontal")).not.toThrow();
    });
  });

  describe("moveTabToGroup", () => {
    it("moves a tab between groups", () => {
      const { addTab } = useAppStore.getState();
      addTab("Tab 1", "local");

      const group1Id = useAppStore.getState().activeTabGroupId;
      const group = getActiveGroup();
      const tabId = group.tabs[0].id;

      // Create a second group to move the tab into.
      const group2Id = useAppStore.getState().addTabGroup("Group 2");
      // Switch back to group 1 so it is the active source.
      useAppStore.getState().setActiveTabGroup(group1Id);

      useAppStore.getState().moveTabToGroup(tabId, group.activeTabSetId ?? "", group2Id);

      // Tab should be gone from the source group.
      expect(getActiveGroup().tabs).toHaveLength(0);

      // Tab should be in the target group.
      const targetGroup = useAppStore.getState().tabGroups.find((g) => g.id === group2Id)!;
      expect(targetGroup.tabs).toHaveLength(1);
      expect(targetGroup.tabs[0].id).toBe(tabId);
    });
  });

  describe("connections", () => {
    it("adds and deletes a connection", () => {
      const { addConnection } = useAppStore.getState();
      addConnection({
        id: "conn-1",
        name: "Test Connection",
        config: { type: "local", config: { shell: "bash" } },
        folderId: null,
      });

      expect(useAppStore.getState().connections).toHaveLength(1);
      expect(useAppStore.getState().connections[0].name).toBe("Test Connection");

      useAppStore.getState().deleteConnection("conn-1");
      expect(useAppStore.getState().connections).toHaveLength(0);
    });
  });

  describe("sidebar", () => {
    it("toggles sidebar collapsed state", () => {
      expect(useAppStore.getState().sidebarCollapsed).toBe(false);
      useAppStore.getState().toggleSidebar();
      expect(useAppStore.getState().sidebarCollapsed).toBe(true);
      useAppStore.getState().toggleSidebar();
      expect(useAppStore.getState().sidebarCollapsed).toBe(false);
    });
  });

  describe("zoom", () => {
    it("initializes zoomLevel to 1.0", () => {
      expect(useAppStore.getState().zoomLevel).toBe(1.0);
    });

    it("zoomIn multiplies by 1.1", () => {
      useAppStore.getState().zoomIn();
      expect(useAppStore.getState().zoomLevel).toBeCloseTo(1.1, 2);
    });

    it("zoomOut divides by 1.1", () => {
      useAppStore.getState().zoomOut();
      expect(useAppStore.getState().zoomLevel).toBeCloseTo(0.91, 2);
    });

    it("zoomReset sets level back to 1.0", () => {
      useAppStore.getState().zoomIn();
      useAppStore.getState().zoomIn();
      useAppStore.getState().zoomReset();
      expect(useAppStore.getState().zoomLevel).toBe(1.0);
    });

    it("caps zoomLevel at 3.0", () => {
      // Zoom in many times to exceed cap
      for (let i = 0; i < 30; i++) {
        useAppStore.getState().zoomIn();
      }
      expect(useAppStore.getState().zoomLevel).toBeLessThanOrEqual(3.0);
    });

    it("floors zoomLevel at 0.5", () => {
      // Zoom out many times to exceed floor
      for (let i = 0; i < 30; i++) {
        useAppStore.getState().zoomOut();
      }
      expect(useAppStore.getState().zoomLevel).toBeGreaterThanOrEqual(0.5);
    });
  });

  describe("toggleZoomActiveTab", () => {
    it("zooms a terminal tab", () => {
      useAppStore.getState().addTab("Shell", "local");
      const activeGroup = getActiveGroup();
      const tabId = activeGroup.activeTabId!;

      useAppStore.getState().toggleZoomActiveTab();

      expect(useAppStore.getState().zoomedTabId).toBe(tabId);
    });

    it("zooms a non-terminal (editor) tab", () => {
      useAppStore.getState().openEditorTab("/some/file.txt", false);
      const activeGroup = getActiveGroup();
      const tabId = activeGroup.activeTabId!;

      useAppStore.getState().toggleZoomActiveTab();

      expect(useAppStore.getState().zoomedTabId).toBe(tabId);
    });

    it("dismisses zoom when already zoomed", () => {
      useAppStore.getState().addTab("Shell", "local");
      useAppStore.getState().toggleZoomActiveTab();
      expect(useAppStore.getState().zoomedTabId).not.toBeNull();

      useAppStore.getState().toggleZoomActiveTab();

      expect(useAppStore.getState().zoomedTabId).toBeNull();
    });
  });

  describe("setActiveTab zoom follow", () => {
    it("follows zoom to any tab type when switching in the same group", () => {
      useAppStore.getState().addTab("Shell", "local");
      useAppStore.getState().openEditorTab("/file.txt", false);
      const group = getActiveGroup();
      const terminalTabId = group.tabs.find((t) => t.contentType === "terminal")!.id;
      const editorTabId = group.tabs.find((t) => t.contentType === "editor")!.id;

      // Zoom the terminal tab, then switch to the editor tab
      useAppStore.getState().setActiveTab(terminalTabId, group.activeTabSetId ?? "");
      useAppStore.getState().toggleZoomActiveTab();
      expect(useAppStore.getState().zoomedTabId).toBe(terminalTabId);

      useAppStore.getState().setActiveTab(editorTabId, group.activeTabSetId ?? "");

      expect(useAppStore.getState().zoomedTabId).toBe(editorTabId);
    });
  });

  describe("openEditorTab", () => {
    it("creates a new editor tab with the given session ID", () => {
      useAppStore.getState().openEditorTab("/remote/file.txt", true, "session-abc");

      const activeGroup = getActiveGroup();
      const tab = activeGroup.tabs.find((t) => t.contentType === "editor");
      expect(tab).toBeDefined();
      expect(tab!.editorMeta?.filePath).toBe("/remote/file.txt");
      expect(tab!.editorMeta?.isRemote).toBe(true);
      expect(tab!.editorMeta?.sftpSessionId).toBe("session-abc");
    });

    it("refreshes sftpSessionId on existing remote editor tab when reopened with a new session", () => {
      // Open the file for the first time with session "old-session"
      useAppStore.getState().openEditorTab("/remote/file.txt", true, "old-session");

      // Simulate reconnect: open the same file again with "new-session"
      useAppStore.getState().openEditorTab("/remote/file.txt", true, "new-session");

      const activeGroup = getActiveGroup();
      const tabs = activeGroup.tabs.filter((t) => t.contentType === "editor");
      // Still only one tab
      expect(tabs).toHaveLength(1);
      // Session ID must be updated to the new one
      expect(tabs[0].editorMeta?.sftpSessionId).toBe("new-session");
    });

    it("does not create duplicate tabs for the same remote file", () => {
      useAppStore.getState().openEditorTab("/remote/file.txt", true, "session-1");
      useAppStore.getState().openEditorTab("/remote/file.txt", true, "session-2");

      const activeGroup = getActiveGroup();
      const tabs = activeGroup.tabs.filter((t) => t.contentType === "editor");
      expect(tabs).toHaveLength(1);
    });
  });

  describe("openLogViewerTab", () => {
    it("creates a log-viewer tab", () => {
      useAppStore.getState().openLogViewerTab();

      const activeGroup = getActiveGroup();
      const logTab = activeGroup.tabs.find((t) => t.contentType === "log-viewer");
      expect(logTab).toBeDefined();
      expect(logTab!.title).toBe("Logs");
    });

    it("reuses existing log-viewer tab when called twice", () => {
      useAppStore.getState().openLogViewerTab();
      useAppStore.getState().openLogViewerTab();

      const activeGroup = getActiveGroup();
      const logTabs = activeGroup.tabs.filter((t) => t.contentType === "log-viewer");
      expect(logTabs).toHaveLength(1);
    });
  });

  describe("attachAgentPersistentSession", () => {
    const def: AgentDefinitionInfo = {
      id: "conn1",
      name: "Test Shell",
      sessionType: "local",
      config: {},
      persistent: true,
      folderId: null,
    };

    beforeEach(() => {
      // Seed a running persistent session so the attach path can proceed.
      useAppStore.setState({
        persistentSessions: {
          "agent1:conn1": {
            connectionId: "agent1:conn1",
            sessionId: "session-1",
            state: "running",
            attachedTabIds: [],
          },
        },
      });
    });

    it("removes the tab when attach_persistent_tab fails (regression: no blank terminal)", async () => {
      vi.mocked(api.attachPersistentTab).mockRejectedValueOnce(
        new Error("Session no longer alive")
      );

      const tabsBefore = getActiveGroup().tabs.length;

      await useAppStore.getState().attachAgentPersistentSession("agent1", def);

      const tabsAfter = getActiveGroup().tabs.length;
      // The broken tab must have been removed — net tab count unchanged.
      expect(tabsAfter).toBe(tabsBefore);
    });

    it("keeps the tab when attach_persistent_tab succeeds", async () => {
      vi.mocked(api.attachPersistentTab).mockResolvedValueOnce(1);

      const tabsBefore = getActiveGroup().tabs.length;

      await useAppStore.getState().attachAgentPersistentSession("agent1", def);

      const tabsAfter = getActiveGroup().tabs.length;
      expect(tabsAfter).toBe(tabsBefore + 1);
    });
  });

  // Cross-instance connection propagation: when connections.json changes in
  // another running instance the backend emits "connections-changed", which
  // triggers reloadConnectionsFromBackend().  These tests verify the reload
  // mechanism correctly replaces the in-store list with whatever the backend
  // returns, and that the sequence guard prevents a stale in-flight reload from
  // overwriting a fresher one that has already been applied.
  describe("reloadConnectionsFromBackend", () => {
    const makeConn = (id: string, name: string) => ({
      id,
      name,
      config: { type: "local", config: { shell: "bash" } },
      folderId: null,
      sourceFile: null,
    });

    it("replaces store connections with the fresh list returned by the backend", async () => {
      // Seed stale in-store state that includes a connection deleted in another instance.
      useAppStore.setState({ connections: [makeConn("conn-deleted", "Deleted Connection")] });

      // Backend returns a list without the deleted connection.
      vi.mocked(storage.loadConnections).mockResolvedValueOnce({
        connections: [makeConn("conn-kept", "Kept Connection")],
        folders: [],
        agents: [],
        externalErrors: [],
      });

      useAppStore.getState().reloadConnectionsFromBackend();
      await flushPromises();

      const { connections } = useAppStore.getState();
      const names = connections.map((c) => c.name);
      expect(names).not.toContain("Deleted Connection");
      expect(names).toContain("Kept Connection");
    });

    it("sequence guard drops a stale in-flight reload when a newer one already applied", async () => {
      let resolveStale!: (v: Awaited<ReturnType<typeof storage.loadConnections>>) => void;
      let resolveFresh!: (v: Awaited<ReturnType<typeof storage.loadConnections>>) => void;

      // seq 1: stale data (the old list with the deleted connection)
      vi.mocked(storage.loadConnections).mockReturnValueOnce(
        new Promise((r) => {
          resolveStale = r;
        })
      );
      // seq 2: fresh data (deleted connection removed)
      vi.mocked(storage.loadConnections).mockReturnValueOnce(
        new Promise((r) => {
          resolveFresh = r;
        })
      );

      useAppStore.getState().reloadConnectionsFromBackend(); // seq 1
      useAppStore.getState().reloadConnectionsFromBackend(); // seq 2

      // Resolve seq 2 FIRST — its result must be applied.
      resolveFresh({
        connections: [makeConn("conn-fresh", "Fresh Connection")],
        folders: [],
        agents: [],
        externalErrors: [],
      });
      await flushPromises();

      // Resolve seq 1 SECOND — its stale result must be dropped.
      resolveStale({
        connections: [makeConn("conn-stale", "Stale Connection")],
        folders: [],
        agents: [],
        externalErrors: [],
      });
      await flushPromises();

      const { connections } = useAppStore.getState();
      const names = connections.map((c) => c.name);
      expect(names).toContain("Fresh Connection");
      expect(names).not.toContain("Stale Connection");
    });
  });
});
