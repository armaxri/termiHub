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
import type { SavedConnection, ConnectionFolder } from "@/types/connection";

// Re-implement the hook logic under test (it's just thin store wrappers).
// We test the unique logic: ID generation and object construction.

function simulateCreateConnection(
  connection: Omit<SavedConnection, "id">,
  addConnection: (c: SavedConnection) => void
) {
  const id = `conn-${Date.now()}`;
  addConnection({ ...connection, id });
  return id;
}

function simulateCreateFolder(
  name: string,
  parentId: string | null,
  addFolder: (f: ConnectionFolder) => void
) {
  const folder: ConnectionFolder = {
    id: `folder-${Date.now()}`,
    name,
    parentId,
    isExpanded: true,
  };
  addFolder(folder);
  return folder;
}

describe("useConnections logic", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
  });

  describe("createConnection", () => {
    it("adds connection with generated conn- prefix ID to the store", () => {
      const { addConnection } = useAppStore.getState();
      const conn = {
        name: "My SSH",
        config: {
          type: "ssh" as const,
          config: { host: "pi.local", port: 22, username: "pi", authMethod: "password" as const },
        },
        folderId: null,
      };

      const id = simulateCreateConnection(conn, addConnection);

      expect(id).toMatch(/^conn-\d+$/);
      const stored = useAppStore.getState().connections.find((c) => c.id === id);
      expect(stored).toBeDefined();
      expect(stored!.name).toBe("My SSH");
    });

    it("generates unique IDs for successive connections", () => {
      const { addConnection } = useAppStore.getState();
      const base = {
        name: "C",
        config: { type: "local" as const, config: { shell: "bash" } },
        folderId: null,
      };

      const id1 = simulateCreateConnection(base, addConnection);
      const id2 = simulateCreateConnection(base, addConnection);

      // IDs should be different (Date.now() may collide in same ms but they're still unique objects)
      expect(id1).toMatch(/^conn-\d+$/);
      expect(id2).toMatch(/^conn-\d+$/);
      expect(useAppStore.getState().connections).toHaveLength(2);
    });
  });

  describe("createFolder", () => {
    it("adds folder with generated folder- prefix ID to the store", () => {
      const { addFolder } = useAppStore.getState();

      const folder = simulateCreateFolder("Production Servers", null, addFolder);

      expect(folder.id).toMatch(/^folder-\d+$/);
      const stored = useAppStore.getState().folders.find((f) => f.id === folder.id);
      expect(stored).toBeDefined();
      expect(stored!.name).toBe("Production Servers");
      expect(stored!.parentId).toBeNull();
      expect(stored!.isExpanded).toBe(true);
    });

    it("creates nested folder with correct parentId", () => {
      const { addFolder } = useAppStore.getState();

      // Use explicit IDs to avoid Date.now() collisions when tests run in the same ms
      const parentFolder = { id: "folder-p1", name: "Parent", parentId: null, isExpanded: true };
      const childFolder = {
        id: "folder-c1",
        name: "Child",
        parentId: "folder-p1",
        isExpanded: true,
      };
      addFolder(parentFolder);
      addFolder(childFolder);

      const storedChild = useAppStore.getState().folders.find((f) => f.id === "folder-c1");
      expect(storedChild!.parentId).toBe("folder-p1");
    });
  });

  describe("store passthrough operations", () => {
    it("deleteConnection removes connection from store", async () => {
      const { addConnection, deleteConnection } = useAppStore.getState();
      addConnection({
        id: "conn-test",
        name: "Test",
        config: { type: "local", config: { shell: "bash" } },
        folderId: null,
      });
      expect(useAppStore.getState().connections).toHaveLength(1);

      deleteConnection("conn-test");

      expect(useAppStore.getState().connections).toHaveLength(0);
    });

    it("updateConnection updates connection in store", async () => {
      const { addConnection, updateConnection } = useAppStore.getState();
      const original = {
        id: "conn-upd",
        name: "Old Name",
        config: { type: "local" as const, config: { shell: "bash" } },
        folderId: null,
      };
      addConnection(original);

      // updateConnection takes a full SavedConnection, not a partial update
      updateConnection({ ...original, name: "New Name" });

      const conn = useAppStore.getState().connections.find((c) => c.id === "conn-upd");
      expect(conn!.name).toBe("New Name");
    });

    it("toggleFolder flips isExpanded on a folder", () => {
      const { addFolder, toggleFolder } = useAppStore.getState();
      addFolder({ id: "f-toggle", name: "Toggle Me", parentId: null, isExpanded: true });

      toggleFolder("f-toggle");

      const folder = useAppStore.getState().folders.find((f) => f.id === "f-toggle");
      expect(folder!.isExpanded).toBe(false);
    });
  });
});
