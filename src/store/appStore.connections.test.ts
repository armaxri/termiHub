import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock service modules before importing the store
vi.mock("@/services/storage", () => ({
  loadConnections: vi.fn(() =>
    Promise.resolve({ connections: [], folders: [], externalSources: [] })
  ),
  persistConnection: vi.fn(() => Promise.resolve()),
  removeConnection: vi.fn(() => Promise.resolve()),
  persistFolder: vi.fn(() => Promise.resolve()),
  removeFolder: vi.fn(() => Promise.resolve()),
  getSettings: vi.fn(() => Promise.resolve({ version: "1", externalConnectionFiles: [] })),
  saveSettings: vi.fn(() => Promise.resolve()),
  saveExternalFile: vi.fn(() => Promise.resolve()),
  reloadExternalConnections: vi.fn(() => Promise.resolve([])),
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
import type { SavedConnection, ConnectionFolder } from "@/types/connection";

function makeConnection(overrides: Partial<SavedConnection> = {}): SavedConnection {
  return {
    id: `conn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name: "Test Connection",
    config: { type: "local", config: { shellType: "bash" } },
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
  });

  describe("toggleFolder", () => {
    it("toggles folder expanded state", () => {
      const folder = makeFolder({ id: "f-1", isExpanded: true });
      useAppStore.setState({ folders: [folder] });

      useAppStore.getState().toggleFolder("f-1");

      const toggled = useAppStore.getState().folders.find((f) => f.id === "f-1");
      expect(toggled?.isExpanded).toBe(false);
    });

    it("toggles back to expanded", () => {
      const folder = makeFolder({ id: "f-1", isExpanded: false });
      useAppStore.setState({ folders: [folder] });

      useAppStore.getState().toggleFolder("f-1");

      const toggled = useAppStore.getState().folders.find((f) => f.id === "f-1");
      expect(toggled?.isExpanded).toBe(true);
    });

    it("does not affect other folders", () => {
      const folder1 = makeFolder({ id: "f-1", isExpanded: true });
      const folder2 = makeFolder({ id: "f-2", isExpanded: false });
      useAppStore.setState({ folders: [folder1, folder2] });

      useAppStore.getState().toggleFolder("f-1");

      const folders = useAppStore.getState().folders;
      expect(folders.find((f) => f.id === "f-1")?.isExpanded).toBe(false);
      expect(folders.find((f) => f.id === "f-2")?.isExpanded).toBe(false);
    });
  });

  describe("updateConnection", () => {
    it("updates connection fields", () => {
      const conn = makeConnection({ id: "c-1", name: "Old Name" });
      useAppStore.setState({ connections: [conn] });

      useAppStore.getState().updateConnection({ ...conn, name: "New Name" });

      const updated = useAppStore.getState().connections.find((c) => c.id === "c-1");
      expect(updated?.name).toBe("New Name");
    });

    it("only updates the targeted connection", () => {
      const conn1 = makeConnection({ id: "c-1", name: "Connection 1" });
      const conn2 = makeConnection({ id: "c-2", name: "Connection 2" });
      useAppStore.setState({ connections: [conn1, conn2] });

      useAppStore.getState().updateConnection({ ...conn1, name: "Updated" });

      const connections = useAppStore.getState().connections;
      expect(connections.find((c) => c.id === "c-1")?.name).toBe("Updated");
      expect(connections.find((c) => c.id === "c-2")?.name).toBe("Connection 2");
    });
  });

  describe("addFolder", () => {
    it("adds a folder to the list", () => {
      const folder = makeFolder({ id: "f-new", name: "New Folder" });

      useAppStore.getState().addFolder(folder);

      expect(useAppStore.getState().folders).toHaveLength(1);
      expect(useAppStore.getState().folders[0].name).toBe("New Folder");
    });

    it("adds folder with parentId", () => {
      const parent = makeFolder({ id: "f-parent" });
      const child = makeFolder({ id: "f-child", parentId: "f-parent" });

      useAppStore.getState().addFolder(parent);
      useAppStore.getState().addFolder(child);

      const folders = useAppStore.getState().folders;
      expect(folders).toHaveLength(2);
      expect(folders.find((f) => f.id === "f-child")?.parentId).toBe("f-parent");
    });
  });

  describe("deleteFolder", () => {
    it("removes the folder from the list", () => {
      const folder = makeFolder({ id: "f-1" });
      useAppStore.setState({ folders: [folder] });

      useAppStore.getState().deleteFolder("f-1");

      expect(useAppStore.getState().folders).toHaveLength(0);
    });

    it("reparents child connections to root", () => {
      const folder = makeFolder({ id: "f-1" });
      const conn = makeConnection({ id: "c-1", folderId: "f-1" });
      useAppStore.setState({ folders: [folder], connections: [conn] });

      useAppStore.getState().deleteFolder("f-1");

      const updated = useAppStore.getState().connections.find((c) => c.id === "c-1");
      expect(updated?.folderId).toBeNull();
    });

    it("reparents child folders to the deleted folder's parent", () => {
      const parent = makeFolder({ id: "f-parent", parentId: null });
      const deleted = makeFolder({ id: "f-deleted", parentId: "f-parent" });
      const child = makeFolder({ id: "f-child", parentId: "f-deleted" });
      useAppStore.setState({ folders: [parent, deleted, child] });

      useAppStore.getState().deleteFolder("f-deleted");

      const folders = useAppStore.getState().folders;
      expect(folders).toHaveLength(2);
      expect(folders.find((f) => f.id === "f-child")?.parentId).toBe("f-parent");
    });

    it("reparents child folders to root when deleting top-level folder", () => {
      const topLevel = makeFolder({ id: "f-top", parentId: null });
      const child = makeFolder({ id: "f-child", parentId: "f-top" });
      useAppStore.setState({ folders: [topLevel, child] });

      useAppStore.getState().deleteFolder("f-top");

      const folders = useAppStore.getState().folders;
      expect(folders).toHaveLength(1);
      expect(folders[0].id).toBe("f-child");
      expect(folders[0].parentId).toBeNull();
    });

    it("does not affect connections in other folders", () => {
      const folder1 = makeFolder({ id: "f-1" });
      const folder2 = makeFolder({ id: "f-2" });
      const conn1 = makeConnection({ id: "c-1", folderId: "f-1" });
      const conn2 = makeConnection({ id: "c-2", folderId: "f-2" });
      useAppStore.setState({ folders: [folder1, folder2], connections: [conn1, conn2] });

      useAppStore.getState().deleteFolder("f-1");

      const connections = useAppStore.getState().connections;
      expect(connections.find((c) => c.id === "c-1")?.folderId).toBeNull();
      expect(connections.find((c) => c.id === "c-2")?.folderId).toBe("f-2");
    });
  });

  describe("duplicateConnection", () => {
    it("creates a copy with 'Copy of' prefix", () => {
      const conn = makeConnection({ id: "c-1", name: "My Connection" });
      useAppStore.setState({ connections: [conn] });

      useAppStore.getState().duplicateConnection("c-1");

      const connections = useAppStore.getState().connections;
      expect(connections).toHaveLength(2);
      expect(connections[1].name).toBe("Copy of My Connection");
    });

    it("generates a unique ID for the duplicate", () => {
      const conn = makeConnection({ id: "c-1" });
      useAppStore.setState({ connections: [conn] });

      useAppStore.getState().duplicateConnection("c-1");

      const connections = useAppStore.getState().connections;
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
      useAppStore.setState({ connections: [conn] });

      useAppStore.getState().duplicateConnection("c-1");

      const connections = useAppStore.getState().connections;
      expect(connections[1].config).toEqual(conn.config);
    });

    it("copies the folder assignment", () => {
      const conn = makeConnection({ id: "c-1", folderId: "f-1" });
      useAppStore.setState({ connections: [conn] });

      useAppStore.getState().duplicateConnection("c-1");

      const connections = useAppStore.getState().connections;
      expect(connections[1].folderId).toBe("f-1");
    });

    it("does nothing for non-existent connection", () => {
      const conn = makeConnection({ id: "c-1" });
      useAppStore.setState({ connections: [conn] });

      useAppStore.getState().duplicateConnection("c-nonexistent");

      expect(useAppStore.getState().connections).toHaveLength(1);
    });
  });

  describe("moveConnectionToFolder", () => {
    it("moves connection to a folder", () => {
      const conn = makeConnection({ id: "c-1", folderId: null });
      useAppStore.setState({ connections: [conn] });

      useAppStore.getState().moveConnectionToFolder("c-1", "f-1");

      const updated = useAppStore.getState().connections.find((c) => c.id === "c-1");
      expect(updated?.folderId).toBe("f-1");
    });

    it("moves connection to root (null folderId)", () => {
      const conn = makeConnection({ id: "c-1", folderId: "f-1" });
      useAppStore.setState({ connections: [conn] });

      useAppStore.getState().moveConnectionToFolder("c-1", null);

      const updated = useAppStore.getState().connections.find((c) => c.id === "c-1");
      expect(updated?.folderId).toBeNull();
    });

    it("does not affect other connections", () => {
      const conn1 = makeConnection({ id: "c-1", folderId: null });
      const conn2 = makeConnection({ id: "c-2", folderId: "f-2" });
      useAppStore.setState({ connections: [conn1, conn2] });

      useAppStore.getState().moveConnectionToFolder("c-1", "f-1");

      const connections = useAppStore.getState().connections;
      expect(connections.find((c) => c.id === "c-1")?.folderId).toBe("f-1");
      expect(connections.find((c) => c.id === "c-2")?.folderId).toBe("f-2");
    });
  });

  describe("setEditingConnection", () => {
    it("sets editing connection ID", () => {
      useAppStore.getState().setEditingConnection("c-1");

      const state = useAppStore.getState();
      expect(state.editingConnectionId).toBe("c-1");
      expect(state.editingConnectionFolderId).toBeNull();
    });

    it("sets editing connection with folder ID", () => {
      useAppStore.getState().setEditingConnection("c-1", "f-1");

      const state = useAppStore.getState();
      expect(state.editingConnectionId).toBe("c-1");
      expect(state.editingConnectionFolderId).toBe("f-1");
    });

    it("clears editing state with null", () => {
      useAppStore.getState().setEditingConnection("c-1", "f-1");
      useAppStore.getState().setEditingConnection(null);

      const state = useAppStore.getState();
      expect(state.editingConnectionId).toBeNull();
      expect(state.editingConnectionFolderId).toBeNull();
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

    it("creates an editor tab for remote file with SFTP session", () => {
      useAppStore.getState().openEditorTab("/remote/config.json", true, "sftp-1");

      const state = useAppStore.getState();
      const leaf = findLeaf(state.rootPanel, state.activePanelId!) as LeafPanel;
      expect(leaf.tabs[0].editorMeta?.isRemote).toBe(true);
      expect(leaf.tabs[0].editorMeta?.sftpSessionId).toBe("sftp-1");
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
});
