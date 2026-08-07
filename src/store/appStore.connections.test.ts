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
import { currentConnectionsView } from "./connectionsBridge";
import {
  persistConnection,
  loadConnections,
  removeConnection,
  persistFolder,
} from "@/services/storage";
import type { LeafPanel } from "@/types/terminal";
import { findLeaf, getAllLeaves } from "@/utils/panelTree";
import type { SavedConnection, ConnectionFolder } from "@/types/connection";
import { seedConnectionsRegion, setupConnectionsRegion } from "@/test/connectionsHarness";

// The connections tree is region-authoritative (#2401): seed the `connections`
// region directly and read it back via `currentConnectionsView()`. The lifecycle
// actions dispatch `connection.*` intents that the harness's transport double
// folds into the region (standing in for the server-side fold), so an
// action-then-read sequence reflects the transition synchronously.
setupConnectionsRegion();

function makeConnection(overrides: Partial<SavedConnection> = {}): SavedConnection {
  return {
    id: `conn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name: "Test Connection",
    config: { type: "local", config: { shell: "bash" } },
    folderId: null,
    ...overrides,
  };
}

function makeFolder(overrides: Partial<ConnectionFolder> = {}): ConnectionFolder {
  return {
    id: `folder-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name: "Test Folder",
    parentId: null,
    isExpanded: true,
    ...overrides,
  };
}

describe("appStore — connections, folders, and special tabs", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    vi.mocked(loadConnections).mockReset();
    vi.mocked(loadConnections).mockResolvedValue({
      connections: [],
      folders: [],
      agents: [],
      externalErrors: [],
    });
    vi.mocked(removeConnection).mockReset();
    vi.mocked(removeConnection).mockResolvedValue(undefined);
    vi.mocked(persistFolder).mockReset();
    vi.mocked(persistFolder).mockResolvedValue(undefined);
  });

  describe("toggleFolder", () => {
    it("toggles folder expanded state", () => {
      const folder = makeFolder({ id: "f-1", isExpanded: true });
      seedConnectionsRegion({ folders: [folder] });

      useAppStore.getState().toggleFolder("f-1");

      const toggled = currentConnectionsView().folders.find((f) => f.id === "f-1");
      expect(toggled?.isExpanded).toBe(false);
    });

    it("toggles back to expanded", () => {
      const folder = makeFolder({ id: "f-1", isExpanded: false });
      seedConnectionsRegion({ folders: [folder] });

      useAppStore.getState().toggleFolder("f-1");

      const toggled = currentConnectionsView().folders.find((f) => f.id === "f-1");
      expect(toggled?.isExpanded).toBe(true);
    });

    it("does not affect other folders", () => {
      const folder1 = makeFolder({ id: "f-1", isExpanded: true });
      const folder2 = makeFolder({ id: "f-2", isExpanded: false });
      seedConnectionsRegion({ folders: [folder1, folder2] });

      useAppStore.getState().toggleFolder("f-1");

      const folders = currentConnectionsView().folders;
      expect(folders.find((f) => f.id === "f-1")?.isExpanded).toBe(false);
      expect(folders.find((f) => f.id === "f-2")?.isExpanded).toBe(false);
    });
  });

  describe("updateConnection", () => {
    it("updates connection fields", () => {
      const conn = makeConnection({ id: "c-1", name: "Old Name" });
      seedConnectionsRegion({ connections: [conn] });

      useAppStore.getState().updateConnection({ ...conn, name: "New Name" });

      const updated = currentConnectionsView().connections.find((c) => c.id === "c-1");
      expect(updated?.name).toBe("New Name");
    });

    it("only updates the targeted connection", () => {
      const conn1 = makeConnection({ id: "c-1", name: "Connection 1" });
      const conn2 = makeConnection({ id: "c-2", name: "Connection 2" });
      seedConnectionsRegion({ connections: [conn1, conn2] });

      useAppStore.getState().updateConnection({ ...conn1, name: "Updated" });

      const connections = currentConnectionsView().connections;
      expect(connections.find((c) => c.id === "c-1")?.name).toBe("Updated");
      expect(connections.find((c) => c.id === "c-2")?.name).toBe("Connection 2");
    });
  });

  describe("addFolder", () => {
    it("adds a folder to the list", () => {
      const folder = makeFolder({ id: "f-new", name: "New Folder" });

      useAppStore.getState().addFolder(folder);

      expect(currentConnectionsView().folders).toHaveLength(1);
      expect(currentConnectionsView().folders[0].name).toBe("New Folder");
    });

    it("adds folder with parentId", () => {
      const parent = makeFolder({ id: "f-parent" });
      const child = makeFolder({ id: "f-child", parentId: "f-parent" });

      useAppStore.getState().addFolder(parent);
      useAppStore.getState().addFolder(child);

      const folders = currentConnectionsView().folders;
      expect(folders).toHaveLength(2);
      expect(folders.find((f) => f.id === "f-child")?.parentId).toBe("f-parent");
    });
  });

  describe("deleteFolder", () => {
    it("removes the folder from the list", () => {
      const folder = makeFolder({ id: "f-1" });
      seedConnectionsRegion({ folders: [folder] });

      useAppStore.getState().deleteFolder("f-1");

      expect(currentConnectionsView().folders).toHaveLength(0);
    });

    it("reparents child connections to root", () => {
      const folder = makeFolder({ id: "f-1" });
      const conn = makeConnection({ id: "c-1", folderId: "f-1" });
      seedConnectionsRegion({ folders: [folder], connections: [conn] });

      useAppStore.getState().deleteFolder("f-1");

      const updated = currentConnectionsView().connections.find((c) => c.id === "c-1");
      expect(updated?.folderId).toBeNull();
    });

    it("reparents child folders to the deleted folder's parent", () => {
      const parent = makeFolder({ id: "f-parent", parentId: null });
      const deleted = makeFolder({ id: "f-deleted", parentId: "f-parent" });
      const child = makeFolder({ id: "f-child", parentId: "f-deleted" });
      seedConnectionsRegion({ folders: [parent, deleted, child] });

      useAppStore.getState().deleteFolder("f-deleted");

      const folders = currentConnectionsView().folders;
      expect(folders).toHaveLength(2);
      expect(folders.find((f) => f.id === "f-child")?.parentId).toBe("f-parent");
    });

    it("reparents child folders to root when deleting top-level folder", () => {
      const topLevel = makeFolder({ id: "f-top", parentId: null });
      const child = makeFolder({ id: "f-child", parentId: "f-top" });
      seedConnectionsRegion({ folders: [topLevel, child] });

      useAppStore.getState().deleteFolder("f-top");

      const folders = currentConnectionsView().folders;
      expect(folders).toHaveLength(1);
      expect(folders[0].id).toBe("f-child");
      expect(folders[0].parentId).toBeNull();
    });

    it("does not affect connections in other folders", () => {
      const folder1 = makeFolder({ id: "f-1" });
      const folder2 = makeFolder({ id: "f-2" });
      const conn1 = makeConnection({ id: "c-1", folderId: "f-1" });
      const conn2 = makeConnection({ id: "c-2", folderId: "f-2" });
      seedConnectionsRegion({ folders: [folder1, folder2], connections: [conn1, conn2] });

      useAppStore.getState().deleteFolder("f-1");

      const connections = currentConnectionsView().connections;
      expect(connections.find((c) => c.id === "c-1")?.folderId).toBeNull();
      expect(connections.find((c) => c.id === "c-2")?.folderId).toBe("f-2");
    });
  });

  describe("deleteConnection", () => {
    it("removes the connection from state immediately (optimistic)", () => {
      const conn = makeConnection({ id: "c-1" });
      seedConnectionsRegion({ connections: [conn] });

      useAppStore.getState().deleteConnection("c-1");

      expect(currentConnectionsView().connections).toHaveLength(0);
    });

    it("does not affect other connections", () => {
      const conn1 = makeConnection({ id: "c-1" });
      const conn2 = makeConnection({ id: "c-2" });
      seedConnectionsRegion({ connections: [conn1, conn2] });

      useAppStore.getState().deleteConnection("c-1");

      const remaining = currentConnectionsView().connections;
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe("c-2");
    });

    it("calls removeConnection with the connection's source file, then leaves the region without it", async () => {
      const survivor = makeConnection({ id: "c-2", name: "Survivor" });
      const deleted = makeConnection({ id: "c-1", name: "To Delete", sourceFile: "extra.json" });
      seedConnectionsRegion({ connections: [deleted, survivor] });

      useAppStore.getState().deleteConnection("c-1");

      // Flush the removeConnection command.
      await Promise.resolve();
      await Promise.resolve();

      // The delete routes to the persist command with the entry's source file; the
      // authoritative reconcile is the command's server-side fold (#2389), so there
      // is no frontend reload here — the optimistic `connection.remove` intent
      // already dropped it from the region.
      expect(vi.mocked(removeConnection)).toHaveBeenCalledWith("c-1", "extra.json");
      const final = currentConnectionsView().connections;
      expect(final).toHaveLength(1);
      expect(final[0].id).toBe("c-2");
    });

    // The frontend reload-sequence guard (`_connReloadSeq` / `applyConnectionReload`)
    // that used to protect against stale concurrent reloads resurrecting a deleted
    // connection was removed in #2401: the region is fed server-side, and
    // `fold_connections_from_manager` runs inside each persist command in commit
    // order, so a stale frontend reload can no longer overwrite a fresher one.
    // Ordering is now covered by the `connections_projection` Rust store tests.
  });

  describe("bulkDeleteConnections", () => {
    it("removes all specified connections from state immediately (optimistic)", () => {
      const c1 = makeConnection({ id: "c-1" });
      const c2 = makeConnection({ id: "c-2" });
      const c3 = makeConnection({ id: "c-3" });
      seedConnectionsRegion({ connections: [c1, c2, c3] });

      useAppStore.getState().bulkDeleteConnections(["c-1", "c-2"]);

      const remaining = currentConnectionsView().connections;
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe("c-3");
    });

    it("calls removeConnection for each deleted connection", async () => {
      const c1 = makeConnection({ id: "c-1", sourceFile: "a.json" });
      const c2 = makeConnection({ id: "c-2", sourceFile: undefined });
      seedConnectionsRegion({ connections: [c1, c2] });

      useAppStore.getState().bulkDeleteConnections(["c-1", "c-2"]);

      await Promise.resolve();
      await Promise.resolve();

      expect(vi.mocked(removeConnection)).toHaveBeenCalledWith("c-1", "a.json");
      expect(vi.mocked(removeConnection)).toHaveBeenCalledWith("c-2", undefined);
    });

    it("drops every deleted connection from the region", async () => {
      const c1 = makeConnection({ id: "c-1" });
      const c2 = makeConnection({ id: "c-2" });
      const c3 = makeConnection({ id: "c-3" });
      seedConnectionsRegion({ connections: [c1, c2, c3] });

      useAppStore.getState().bulkDeleteConnections(["c-1", "c-2"]);

      await Promise.resolve();
      await Promise.resolve();

      // Each removal routes to the persist command (folded server-side, #2389); the
      // optimistic `connection.remove` intents already dropped both from the region.
      expect(currentConnectionsView().connections.map((c) => c.id)).toEqual(["c-3"]);
    });

    it("does not affect connections not in the delete list", () => {
      const c1 = makeConnection({ id: "c-1" });
      const c2 = makeConnection({ id: "c-2" });
      const c3 = makeConnection({ id: "c-3" });
      seedConnectionsRegion({ connections: [c1, c2, c3] });

      useAppStore.getState().bulkDeleteConnections(["c-1"]);

      const remaining = currentConnectionsView().connections;
      expect(remaining.map((c) => c.id)).toEqual(["c-2", "c-3"]);
    });
  });

  describe("duplicateConnection", () => {
    it("creates a copy with 'Copy of' prefix", () => {
      const conn = makeConnection({ id: "c-1", name: "My Connection" });
      seedConnectionsRegion({ connections: [conn] });

      useAppStore.getState().duplicateConnection("c-1");

      const connections = currentConnectionsView().connections;
      expect(connections).toHaveLength(2);
      expect(connections[1].name).toBe("Copy of My Connection");
    });

    it("generates a unique ID for the duplicate", () => {
      const conn = makeConnection({ id: "c-1" });
      seedConnectionsRegion({ connections: [conn] });

      useAppStore.getState().duplicateConnection("c-1");

      const connections = currentConnectionsView().connections;
      expect(connections[1].id).not.toBe("c-1");
    });

    it("copies the connection config", () => {
      const conn = makeConnection({
        id: "c-1",
        config: {
          type: "ssh",
          config: {
            host: "pi.local",
            port: 22,
            username: "pi",
            authMethod: "key",
            keyPath: "/home/.ssh/id_rsa",
          },
        },
      });
      seedConnectionsRegion({ connections: [conn] });

      useAppStore.getState().duplicateConnection("c-1");

      const connections = currentConnectionsView().connections;
      expect(connections[1].config).toEqual(conn.config);
    });

    it("copies the folder assignment", () => {
      const conn = makeConnection({ id: "c-1", folderId: "f-1" });
      seedConnectionsRegion({ connections: [conn] });

      useAppStore.getState().duplicateConnection("c-1");

      const connections = currentConnectionsView().connections;
      expect(connections[1].folderId).toBe("f-1");
    });

    it("does nothing for non-existent connection", () => {
      const conn = makeConnection({ id: "c-1" });
      seedConnectionsRegion({ connections: [conn] });

      useAppStore.getState().duplicateConnection("c-nonexistent");

      expect(currentConnectionsView().connections).toHaveLength(1);
    });
  });

  describe("moveConnectionToFolder", () => {
    it("moves connection to a folder", () => {
      const conn = makeConnection({ id: "c-1", folderId: null });
      seedConnectionsRegion({ connections: [conn] });

      useAppStore.getState().moveConnectionToFolder("c-1", "f-1");

      const updated = currentConnectionsView().connections.find((c) => c.id === "c-1");
      expect(updated?.folderId).toBe("f-1");
    });

    it("moves connection to root (null folderId)", () => {
      const conn = makeConnection({ id: "c-1", folderId: "f-1" });
      seedConnectionsRegion({ connections: [conn] });

      useAppStore.getState().moveConnectionToFolder("c-1", null);

      const updated = currentConnectionsView().connections.find((c) => c.id === "c-1");
      expect(updated?.folderId).toBeNull();
    });

    it("does not affect other connections", () => {
      const conn1 = makeConnection({ id: "c-1", folderId: null });
      const conn2 = makeConnection({ id: "c-2", folderId: "f-2" });
      seedConnectionsRegion({ connections: [conn1, conn2] });

      useAppStore.getState().moveConnectionToFolder("c-1", "f-1");

      const connections = currentConnectionsView().connections;
      expect(connections.find((c) => c.id === "c-1")?.folderId).toBe("f-1");
      expect(connections.find((c) => c.id === "c-2")?.folderId).toBe("f-2");
    });
  });

  describe("openConnectionEditorTab", () => {
    it("creates a connection-editor tab for new connection", () => {
      useAppStore.getState().openConnectionEditorTab("new");

      const state = useAppStore.getState();
      const leaf = findLeaf(state.rootPanel, state.activePanelId!) as LeafPanel;
      expect(leaf.tabs).toHaveLength(1);
      expect(leaf.tabs[0].contentType).toBe("connection-editor");
      expect(leaf.tabs[0].title).toBe("New Connection");
      expect(leaf.tabs[0].connectionEditorMeta?.connectionId).toBe("new");
      expect(leaf.tabs[0].connectionEditorMeta?.folderId).toBeNull();
    });

    it("creates a connection-editor tab with folder ID", () => {
      useAppStore.getState().openConnectionEditorTab("new", "f-1");

      const state = useAppStore.getState();
      const leaf = findLeaf(state.rootPanel, state.activePanelId!) as LeafPanel;
      expect(leaf.tabs[0].connectionEditorMeta?.folderId).toBe("f-1");
    });

    it("creates a tab titled 'Edit: <name>' for existing connections", () => {
      const conn = makeConnection({ id: "c-1", name: "My SSH" });
      seedConnectionsRegion({ connections: [conn] });

      useAppStore.getState().openConnectionEditorTab("c-1");

      const state = useAppStore.getState();
      const leaf = findLeaf(state.rootPanel, state.activePanelId!) as LeafPanel;
      expect(leaf.tabs[0].title).toBe("Edit: My SSH");
      expect(leaf.tabs[0].connectionEditorMeta?.connectionId).toBe("c-1");
    });

    it("reuses existing connection-editor tab for same connection", () => {
      useAppStore.getState().openConnectionEditorTab("new");
      useAppStore.getState().addTab("Shell", "local");
      useAppStore.getState().openConnectionEditorTab("new");

      const state = useAppStore.getState();
      const allLeaves = getAllLeaves(state.rootPanel);
      const editorTabs = allLeaves.flatMap((l) =>
        l.tabs.filter((t) => t.contentType === "connection-editor")
      );
      expect(editorTabs).toHaveLength(1);
    });

    it("creates separate tabs for different connections", () => {
      const conn = makeConnection({ id: "c-1", name: "Conn 1" });
      seedConnectionsRegion({ connections: [conn] });

      useAppStore.getState().openConnectionEditorTab("new");
      useAppStore.getState().openConnectionEditorTab("c-1");

      const state = useAppStore.getState();
      const leaf = findLeaf(state.rootPanel, state.activePanelId!) as LeafPanel;
      expect(leaf.tabs).toHaveLength(2);
    });

    it("creates a 'New Remote Agent' tab for the new-remote-agent sentinel", () => {
      useAppStore.getState().openConnectionEditorTab("new-remote-agent");

      const state = useAppStore.getState();
      const leaf = findLeaf(state.rootPanel, state.activePanelId!) as LeafPanel;
      expect(leaf.tabs).toHaveLength(1);
      expect(leaf.tabs[0].contentType).toBe("connection-editor");
      expect(leaf.tabs[0].title).toBe("New Remote Agent");
      expect(leaf.tabs[0].connectionEditorMeta?.connectionId).toBe("new-remote-agent");
    });

    it("reuses the new-remote-agent tab when opened twice", () => {
      useAppStore.getState().openConnectionEditorTab("new-remote-agent");
      useAppStore.getState().addTab("Shell", "local");
      useAppStore.getState().openConnectionEditorTab("new-remote-agent");

      const state = useAppStore.getState();
      const allLeaves = getAllLeaves(state.rootPanel);
      const editorTabs = allLeaves.flatMap((l) =>
        l.tabs.filter((t) => t.contentType === "connection-editor")
      );
      expect(editorTabs).toHaveLength(1);
    });
  });

  describe("openSettingsTab", () => {
    it("creates a settings tab in the active panel", () => {
      useAppStore.getState().openSettingsTab();

      const state = useAppStore.getState();
      const leaf = findLeaf(state.rootPanel, state.activePanelId!) as LeafPanel;
      expect(leaf.tabs).toHaveLength(1);
      expect(leaf.tabs[0].contentType).toBe("settings");
      expect(leaf.tabs[0].title).toBe("Settings");
    });

    it("reuses existing settings tab instead of creating another", () => {
      useAppStore.getState().openSettingsTab();
      useAppStore.getState().openSettingsTab();

      const state = useAppStore.getState();
      const allLeaves = getAllLeaves(state.rootPanel);
      const settingsTabs = allLeaves.flatMap((l) =>
        l.tabs.filter((t) => t.contentType === "settings")
      );
      expect(settingsTabs).toHaveLength(1);
    });

    it("activates existing settings tab when called again", () => {
      // Create a settings tab and a regular tab
      useAppStore.getState().openSettingsTab();
      useAppStore.getState().addTab("Shell", "local");

      // Open settings again
      useAppStore.getState().openSettingsTab();

      const state = useAppStore.getState();
      const leaf = findLeaf(state.rootPanel, state.activePanelId!) as LeafPanel;
      expect(leaf.activeTabId).toBe(leaf.tabs.find((t) => t.contentType === "settings")?.id);
    });
  });

  describe("openEditorTab", () => {
    it("creates an editor tab with file metadata", () => {
      useAppStore.getState().openEditorTab("/home/test.txt", false);

      const state = useAppStore.getState();
      const leaf = findLeaf(state.rootPanel, state.activePanelId!) as LeafPanel;
      expect(leaf.tabs).toHaveLength(1);
      expect(leaf.tabs[0].contentType).toBe("editor");
      expect(leaf.tabs[0].title).toBe("test.txt");
      expect(leaf.tabs[0].editorMeta?.filePath).toBe("/home/test.txt");
      expect(leaf.tabs[0].editorMeta?.isRemote).toBe(false);
    });

    it("creates an editor tab for remote file backed by a session browser", () => {
      useAppStore.getState().openEditorTab("/remote/config.json", true, undefined, {
        sessionId: "sftp-1",
        connectionType: "ssh",
      });

      const state = useAppStore.getState();
      const leaf = findLeaf(state.rootPanel, state.activePanelId!) as LeafPanel;
      expect(leaf.tabs[0].editorMeta?.isRemote).toBe(true);
      expect(leaf.tabs[0].editorMeta?.sessionBrowser?.sessionId).toBe("sftp-1");
    });

    it("reuses existing editor tab for the same file", () => {
      useAppStore.getState().openEditorTab("/home/test.txt", false);
      useAppStore.getState().openEditorTab("/home/test.txt", false);

      const state = useAppStore.getState();
      const allLeaves = getAllLeaves(state.rootPanel);
      const editorTabs = allLeaves.flatMap((l) => l.tabs.filter((t) => t.contentType === "editor"));
      expect(editorTabs).toHaveLength(1);
    });

    it("creates separate tabs for different files", () => {
      useAppStore.getState().openEditorTab("/home/file1.txt", false);
      useAppStore.getState().openEditorTab("/home/file2.txt", false);

      const state = useAppStore.getState();
      const leaf = findLeaf(state.rootPanel, state.activePanelId!) as LeafPanel;
      expect(leaf.tabs).toHaveLength(2);
    });

    it("creates separate tabs for same path but different remote status", () => {
      useAppStore.getState().openEditorTab("/home/test.txt", false);
      useAppStore.getState().openEditorTab("/home/test.txt", true, "sftp-1");

      const state = useAppStore.getState();
      const leaf = findLeaf(state.rootPanel, state.activePanelId!) as LeafPanel;
      expect(leaf.tabs).toHaveLength(2);
    });
  });

  describe("openScratchEditorTab", () => {
    it("creates an unsaved scratch editor tab seeded with the given content", () => {
      useAppStore
        .getState()
        .openScratchEditorTab("ssh: host (output)", "ssh-host-output.txt", "line1\nline2\n");

      const state = useAppStore.getState();
      const leaf = findLeaf(state.rootPanel, state.activePanelId!) as LeafPanel;
      expect(leaf.tabs).toHaveLength(1);
      const tab = leaf.tabs[0];
      expect(tab.contentType).toBe("editor");
      expect(tab.title).toBe("ssh: host (output)");
      expect(tab.editorMeta?.scratch).toBe(true);
      expect(tab.editorMeta?.scratchContent).toBe("line1\nline2\n");
      expect(tab.editorMeta?.filePath).toBe("ssh-host-output.txt");
      expect(tab.editorMeta?.isRemote).toBe(false);
    });

    it("activates the new scratch tab", () => {
      useAppStore.getState().openScratchEditorTab("Output", "output.txt", "data");

      const state = useAppStore.getState();
      const leaf = findLeaf(state.rootPanel, state.activePanelId!) as LeafPanel;
      expect(leaf.activeTabId).toBe(leaf.tabs[0].id);
      expect(leaf.tabs[0].isActive).toBe(true);
    });

    it("always creates a separate tab for each capture (no dedup)", () => {
      useAppStore.getState().openScratchEditorTab("Output", "output.txt", "first");
      useAppStore.getState().openScratchEditorTab("Output", "output.txt", "second");

      const state = useAppStore.getState();
      const allLeaves = getAllLeaves(state.rootPanel);
      const editorTabs = allLeaves.flatMap((l) => l.tabs.filter((t) => t.contentType === "editor"));
      expect(editorTabs).toHaveLength(2);
      expect(editorTabs.map((t) => t.editorMeta?.scratchContent).sort()).toEqual([
        "first",
        "second",
      ]);
    });
  });

  describe("stripPassword — credential store interaction", () => {
    const mockPersist = vi.mocked(persistConnection);

    beforeEach(() => {
      mockPersist.mockClear();
    });

    function makeSshConn(
      passwordValue: string | undefined,
      savePassword: boolean
    ): SavedConnection {
      return makeConnection({
        id: "c-ssh",
        config: {
          type: "ssh",
          config: {
            host: "host.example.com",
            username: "alice",
            authMethod: "password",
            password: passwordValue,
            savePassword,
          } as unknown as Record<string, unknown>,
        },
      });
    }

    it("strips password from disk when savePassword is false", () => {
      const conn = makeSshConn("secret", false);
      useAppStore.getState().addConnection(conn);

      const persisted = mockPersist.mock.calls[0][0] as SavedConnection;
      expect((persisted.config.config as Record<string, unknown>).password).toBeUndefined();
    });

    it("keeps non-empty password when savePassword is true (for backend routing)", () => {
      const conn = makeSshConn("secret", true);
      useAppStore.getState().addConnection(conn);

      const persisted = mockPersist.mock.calls[0][0] as SavedConnection;
      expect((persisted.config.config as Record<string, unknown>).password).toBe("secret");
    });

    it("strips empty-string password even when savePassword is true (regression: must not overwrite stored credential)", () => {
      // When a user edits an existing connection (e.g. changes the IP) without
      // re-entering the password, the form sends password="". This must NOT be
      // forwarded to the backend as it would overwrite the previously stored credential.
      const conn = makeSshConn("", true);
      useAppStore.getState().updateConnection(conn);

      const persisted = mockPersist.mock.calls[0][0] as SavedConnection;
      expect((persisted.config.config as Record<string, unknown>).password).toBeUndefined();
    });

    it("strips undefined password regardless of savePassword", () => {
      const conn = makeSshConn(undefined, true);
      useAppStore.getState().addConnection(conn);

      const persisted = mockPersist.mock.calls[0][0] as SavedConnection;
      expect((persisted.config.config as Record<string, unknown>).password).toBeUndefined();
    });
  });

  // Persisted-id reconciliation (#863 / #875) moved server-side in #2401: the
  // frontend `reconcileConnectionId` pass is gone. `save_connection` recomputes
  // the name-derived id and `fold_connections_from_manager` reflects it into the
  // authoritative `connections` region — so a connect firing after the save
  // resolves reads the reconciled id from the region. What stays frontend-observable
  // is the optimistic add and that persist is invoked; the id swap is covered by the
  // `connections_projection` Rust store / fold tests.
  describe("addConnection / updateConnection — optimistic write + persist", () => {
    const mockPersist = vi.mocked(persistConnection);

    beforeEach(() => mockPersist.mockClear());

    it("adds the connection to the region optimistically and persists it", () => {
      const conn = makeConnection({ id: "conn-987654", name: "Host Alice" });
      useAppStore.getState().addConnection(conn);

      // The optimistic entry is in the region immediately (via the folded intent).
      expect(currentConnectionsView().connections.map((c) => c.id)).toContain("conn-987654");
      expect(mockPersist).toHaveBeenCalledTimes(1);
      expect((mockPersist.mock.calls[0][0] as SavedConnection).name).toBe("Host Alice");
    });

    it("replaces the entry in the region on a rename and persists it", () => {
      const existing = makeConnection({ id: "old-name", name: "Old Name" });
      seedConnectionsRegion({ connections: [existing] });

      useAppStore.getState().updateConnection({ ...existing, name: "New Name" });

      const view = currentConnectionsView().connections;
      expect(view).toHaveLength(1);
      expect(view[0].name).toBe("New Name");
      expect(mockPersist).toHaveBeenCalledTimes(1);
    });
  });
});
