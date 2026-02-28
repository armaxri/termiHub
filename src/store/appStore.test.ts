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
