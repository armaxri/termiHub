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
import type { LeafPanel } from "@/types/terminal";
import { findLeaf, getAllLeaves } from "@/utils/panelTree";

describe("appStore", () => {
  beforeEach(() => {
    // Reset store state by getting a fresh initial state
    useAppStore.setState(useAppStore.getInitialState());
  });

  describe("addTab", () => {
    it("adds a tab to the active panel", () => {
      const { addTab, activePanelId } = useAppStore.getState();
      addTab("Test Shell", "local", { type: "local", config: { shell: "zsh" } });

      const state = useAppStore.getState();
      const leaf = findLeaf(state.rootPanel, activePanelId!) as LeafPanel;
      expect(leaf.tabs).toHaveLength(1);
      expect(leaf.tabs[0].title).toBe("Test Shell");
      expect(leaf.activeTabId).toBe(leaf.tabs[0].id);
    });

    it("sets new tab as active", () => {
      const { addTab } = useAppStore.getState();
      addTab("Tab 1", "local");
      addTab("Tab 2", "local");

      const state = useAppStore.getState();
      const leaf = findLeaf(state.rootPanel, state.activePanelId!) as LeafPanel;
      expect(leaf.tabs).toHaveLength(2);
      expect(leaf.activeTabId).toBe(leaf.tabs[1].id);
      expect(leaf.tabs[0].isActive).toBe(false);
      expect(leaf.tabs[1].isActive).toBe(true);
    });
  });

  describe("addTab with sessionId", () => {
    it("creates a tab with a pre-existing sessionId", () => {
      const { addTab, activePanelId } = useAppStore.getState();
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

      const state = useAppStore.getState();
      const leaf = findLeaf(state.rootPanel, activePanelId!) as LeafPanel;
      expect(leaf.tabs).toHaveLength(1);
      expect(leaf.tabs[0].sessionId).toBe("existing-session-123");
      expect(leaf.tabs[0].title).toBe("Setup: Pi");
    });

    it("defaults sessionId to null when not provided", () => {
      const { addTab, activePanelId } = useAppStore.getState();
      addTab("Terminal", "local");

      const state = useAppStore.getState();
      const leaf = findLeaf(state.rootPanel, activePanelId!) as LeafPanel;
      expect(leaf.tabs[0].sessionId).toBeNull();
    });
  });

  describe("closeTab", () => {
    it("removes tab and selects next tab", () => {
      const { addTab } = useAppStore.getState();
      addTab("Tab 1", "local");
      addTab("Tab 2", "local");

      const stateAfterAdd = useAppStore.getState();
      const leaf = findLeaf(stateAfterAdd.rootPanel, stateAfterAdd.activePanelId!) as LeafPanel;
      const tabToClose = leaf.tabs[0].id;

      useAppStore.getState().closeTab(tabToClose, stateAfterAdd.activePanelId!);

      const stateAfterClose = useAppStore.getState();
      const updatedLeaf = findLeaf(
        stateAfterClose.rootPanel,
        stateAfterClose.activePanelId!
      ) as LeafPanel;
      expect(updatedLeaf.tabs).toHaveLength(1);
      expect(updatedLeaf.tabs[0].title).toBe("Tab 2");
    });
  });

  describe("setActiveTab", () => {
    it("sets the correct tab active", () => {
      const { addTab } = useAppStore.getState();
      addTab("Tab 1", "local");
      addTab("Tab 2", "local");

      const state = useAppStore.getState();
      const leaf = findLeaf(state.rootPanel, state.activePanelId!) as LeafPanel;
      const firstTabId = leaf.tabs[0].id;

      useAppStore.getState().setActiveTab(firstTabId, state.activePanelId!);

      const updated = useAppStore.getState();
      const updatedLeaf = findLeaf(updated.rootPanel, updated.activePanelId!) as LeafPanel;
      expect(updatedLeaf.activeTabId).toBe(firstTabId);
      expect(updatedLeaf.tabs[0].isActive).toBe(true);
      expect(updatedLeaf.tabs[1].isActive).toBe(false);
    });
  });

  describe("splitPanel", () => {
    it("creates a new panel via split", () => {
      const { splitPanel } = useAppStore.getState();
      splitPanel("horizontal");

      const state = useAppStore.getState();
      const leaves = getAllLeaves(state.rootPanel);
      expect(leaves).toHaveLength(2);
    });
  });

  describe("moveTab", () => {
    it("moves tab between panels", () => {
      // Add a tab then split
      const { addTab, splitPanel } = useAppStore.getState();
      addTab("Tab 1", "local");
      addTab("Tab 2", "local");

      const stateBeforeSplit = useAppStore.getState();
      const originalPanelId = stateBeforeSplit.activePanelId!;
      splitPanel("horizontal");

      const stateAfterSplit = useAppStore.getState();
      const newPanelId = stateAfterSplit.activePanelId!;
      expect(newPanelId).not.toBe(originalPanelId);

      // Get the first tab from the original panel
      const originalLeaf = findLeaf(stateAfterSplit.rootPanel, originalPanelId) as LeafPanel;
      const tabToMove = originalLeaf.tabs[0].id;

      // Move tab to new panel
      useAppStore.getState().moveTab(tabToMove, originalPanelId, newPanelId, 0);

      const finalState = useAppStore.getState();
      const sourceLeaf = findLeaf(finalState.rootPanel, originalPanelId) as LeafPanel;
      const targetLeaf = findLeaf(finalState.rootPanel, newPanelId) as LeafPanel;
      expect(sourceLeaf.tabs).toHaveLength(1);
      expect(targetLeaf.tabs).toHaveLength(1);
      expect(targetLeaf.tabs[0].title).toBe("Tab 1");
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
      const state = useAppStore.getState();
      const leaves = getAllLeaves(state.rootPanel);
      const tabId = leaves[0].activeTabId!;

      useAppStore.getState().toggleZoomActiveTab();

      expect(useAppStore.getState().zoomedTabId).toBe(tabId);
    });

    it("zooms a non-terminal (editor) tab", () => {
      useAppStore.getState().openEditorTab("/some/file.txt", false);
      const state = useAppStore.getState();
      const leaves = getAllLeaves(state.rootPanel);
      const tabId = leaves[0].activeTabId!;

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

  describe("setActivePanel zoom follow", () => {
    it("follows zoom to the new panel's active tab when switching panels", () => {
      useAppStore.getState().addTab("Shell", "local");
      const state0 = useAppStore.getState();
      const panel1Id = state0.activePanelId!;
      const tab1Id = getAllLeaves(state0.rootPanel)[0].activeTabId!;

      useAppStore.getState().splitPanel("horizontal");
      useAppStore.getState().addTab("Shell 2", "local");
      const state1 = useAppStore.getState();
      const panel2Id = state1.activePanelId!;
      const tab2Id = getAllLeaves(state1.rootPanel).find((l) => l.id === panel2Id)!.activeTabId!;

      // Zoom the first panel's tab, then switch focus to the second panel
      useAppStore.getState().setActivePanel(panel1Id);
      useAppStore.getState().toggleZoomActiveTab();
      expect(useAppStore.getState().zoomedTabId).toBe(tab1Id);

      useAppStore.getState().setActivePanel(panel2Id);

      expect(useAppStore.getState().zoomedTabId).toBe(tab2Id);
    });

    it("clears zoom when switching to a panel with no active tab", () => {
      useAppStore.getState().addTab("Shell", "local");
      const state0 = useAppStore.getState();
      const panel1Id = state0.activePanelId!;
      useAppStore.getState().splitPanel("horizontal");
      const panel2Id = useAppStore.getState().activePanelId!;

      useAppStore.getState().setActivePanel(panel1Id);
      useAppStore.getState().toggleZoomActiveTab();
      expect(useAppStore.getState().zoomedTabId).not.toBeNull();

      // Close all tabs in panel 2 so it has no active tab, then switch
      useAppStore.getState().setActivePanel(panel2Id);
      // panel2 has no tabs → activeTabId is null → zoom clears
      expect(useAppStore.getState().zoomedTabId).toBeNull();
    });
  });

  describe("setActiveTab zoom follow", () => {
    it("follows zoom to any tab type when switching in the same panel", () => {
      useAppStore.getState().addTab("Shell", "local");
      useAppStore.getState().openEditorTab("/file.txt", false);
      const state = useAppStore.getState();
      const leaves = getAllLeaves(state.rootPanel);
      const terminalTabId = leaves[0].tabs.find((t) => t.contentType === "terminal")!.id;
      const editorTabId = leaves[0].tabs.find((t) => t.contentType === "editor")!.id;

      // Zoom the terminal tab, then switch to the editor tab
      useAppStore.getState().setActiveTab(terminalTabId, leaves[0].id);
      useAppStore.getState().toggleZoomActiveTab();
      expect(useAppStore.getState().zoomedTabId).toBe(terminalTabId);

      useAppStore.getState().setActiveTab(editorTabId, leaves[0].id);

      expect(useAppStore.getState().zoomedTabId).toBe(editorTabId);
    });
  });

  describe("openEditorTab", () => {
    it("creates a new editor tab with the given session ID", () => {
      useAppStore.getState().openEditorTab("/remote/file.txt", true, "session-abc");

      const state = useAppStore.getState();
      const leaves = getAllLeaves(state.rootPanel);
      const tab = leaves.flatMap((l) => l.tabs).find((t) => t.contentType === "editor");
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

      const state = useAppStore.getState();
      const leaves = getAllLeaves(state.rootPanel);
      const tabs = leaves.flatMap((l) => l.tabs).filter((t) => t.contentType === "editor");
      // Still only one tab
      expect(tabs).toHaveLength(1);
      // Session ID must be updated to the new one
      expect(tabs[0].editorMeta?.sftpSessionId).toBe("new-session");
    });

    it("does not create duplicate tabs for the same remote file", () => {
      useAppStore.getState().openEditorTab("/remote/file.txt", true, "session-1");
      useAppStore.getState().openEditorTab("/remote/file.txt", true, "session-2");

      const state = useAppStore.getState();
      const leaves = getAllLeaves(state.rootPanel);
      const tabs = leaves.flatMap((l) => l.tabs).filter((t) => t.contentType === "editor");
      expect(tabs).toHaveLength(1);
    });
  });

  describe("openLogViewerTab", () => {
    it("creates a log-viewer tab", () => {
      useAppStore.getState().openLogViewerTab();

      const state = useAppStore.getState();
      const leaves = getAllLeaves(state.rootPanel);
      const logTab = leaves.flatMap((l) => l.tabs).find((t) => t.contentType === "log-viewer");
      expect(logTab).toBeDefined();
      expect(logTab!.title).toBe("Logs");
    });

    it("reuses existing log-viewer tab when called twice", () => {
      useAppStore.getState().openLogViewerTab();
      useAppStore.getState().openLogViewerTab();

      const state = useAppStore.getState();
      const leaves = getAllLeaves(state.rootPanel);
      const logTabs = leaves.flatMap((l) => l.tabs).filter((t) => t.contentType === "log-viewer");
      expect(logTabs).toHaveLength(1);
    });
  });
});
