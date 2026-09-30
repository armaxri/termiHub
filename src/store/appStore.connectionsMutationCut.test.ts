/**
 * Connections lifecycle — region-authoritative, persist-command single writer
 * (#2225 PR B, #2831).
 *
 * The connection-tree lifecycle actions are thin backend-command wrappers: each
 * calls its persist command — the only writer of the `connections` region,
 * which writes disk and folds it into the region in one backend step — and
 * shows a client-local optimistic overlay until the persist settles. No
 * `connection.*` intent is dispatched. `appStore` holds no `connections` /
 * `folders` slice.
 *
 * These tests drive the real `appStore` actions against
 * {@link ConnectionsBackendDouble} (disk + region + the `commit` choke point)
 * and assert, per action: the optimistic view it shows at once, the persist
 * command it goes through, and that once settled the view every reader sources
 * ({@link currentConnectionsView}) equals the backend region and disk exactly.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { ConnectionsBackendDouble } from "@/test/connectionsBackendDouble";

const backend = vi.hoisted(() => ({ current: null as ConnectionsBackendDouble | null }));

vi.mock("@/services/storage", () => ({
  loadConnections: vi.fn(() =>
    Promise.resolve({ connections: [], folders: [], agents: [], externalErrors: [] })
  ),
  persistConnection: vi.fn((...a: [never]) => backend.current!.persistConnection(...a)),
  removeConnection: vi.fn((id: string) => backend.current!.removeConnection(id)),
  persistFolder: vi.fn((...a: [never]) => backend.current!.persistFolder(...a)),
  removeFolder: vi.fn((id: string) => backend.current!.removeFolder(id)),
  reorderConnections: vi.fn((ids: string[]) => backend.current!.reorderConnections(ids)),
  moveConnectionToFile: vi.fn((...a: [string, string | null, string | null]) =>
    backend.current!.moveConnectionToFile(...a)
  ),
  saveConnectionToFile: vi.fn((...a: [never, string | null]) =>
    backend.current!.saveConnectionToFile(...a)
  ),
  persistAgent: vi.fn(() => Promise.resolve()),
  removeAgent: vi.fn(() => Promise.resolve()),
  reorderAgents: vi.fn(() => Promise.resolve()),
  getSettings: vi.fn(() =>
    Promise.resolve({
      version: "1",
      externalConnectionFiles: [],
      powerMonitoringEnabled: true,
      fileBrowserEnabled: true,
    })
  ),
  saveSettings: vi.fn(() => Promise.resolve()),
  reloadExternalConnections: vi.fn(() => Promise.resolve([])),
  getRecoveryWarnings: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/services/api", () => ({
  sftpOpen: vi.fn(),
  sftpClose: vi.fn(),
  sftpListDir: vi.fn(),
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
  getConnectionTypes: vi.fn(() => Promise.resolve([])),
}));

import { useAppStore } from "./appStore";
import { reorderConnections as apiReorderConnections } from "@/services/storage";
import {
  currentConnectionsView,
  ensureConnectionsSubscribed,
  setConnectionTransportForTest,
  stopConnectionsSubscription,
} from "./connectionsBridge";
import type { ConnectionFolder, SavedConnection } from "@/types/connection";

function makeConnection(id: string, folderId: string | null = null): SavedConnection {
  return {
    id,
    name: `Conn ${id}`,
    config: { type: "ssh", config: { host: `h-${id}`, port: 22 } } as never,
    folderId,
  };
}

function makeFolder(
  id: string,
  parentId: string | null = null,
  isExpanded = false
): ConnectionFolder {
  return { id, name: `F ${id}`, parentId, isExpanded };
}

let double: ConnectionsBackendDouble;

/** Let every in-flight persist settle and every fold frame land. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
}

/** Start from this tree on disk (and in the region). */
async function startWith(view: {
  folders?: ConnectionFolder[];
  connections?: SavedConnection[];
}): Promise<void> {
  stopConnectionsSubscription();
  double = new ConnectionsBackendDouble({
    folders: view.folders ?? [],
    connections: view.connections ?? [],
  });
  backend.current = double;
  setConnectionTransportForTest(double);
  await ensureConnectionsSubscribed();
}

/**
 * Settle, then assert the view every reader sees equals the backend region and
 * disk exactly, and that no `connection.*` intent was ever dispatched.
 */
async function expectSettledParity(): Promise<void> {
  await settle();
  expect(currentConnectionsView()).toEqual(double.regionView());
  expect(double.regionView()).toEqual(double.diskView());
  expect(double.dispatched).toEqual([]);
}

const ids = () => currentConnectionsView().connections.map((c) => c.id);

beforeEach(async () => {
  useAppStore.setState(useAppStore.getInitialState());
  vi.clearAllMocks();
  await startWith({});
});

afterEach(() => {
  stopConnectionsSubscription();
  setConnectionTransportForTest(null);
  backend.current = null;
});

describe("connections lifecycle — every action lands through its persist command", () => {
  it("addConnection shows the new entry at once and persists it", async () => {
    useAppStore.getState().addConnection(makeConnection("a"));
    expect(ids()).toEqual(["a"]);

    await expectSettledParity();
    expect(double.calls).toEqual(["persistConnection"]);
    expect(ids()).toEqual(["a"]);
  });

  it("bulkAddConnections persists one entry per connection", async () => {
    useAppStore
      .getState()
      .bulkAddConnections([makeConnection("a"), makeConnection("b"), makeConnection("c")]);
    expect(ids()).toEqual(["a", "b", "c"]);

    await expectSettledParity();
    expect(double.calls).toHaveLength(3);
    expect(ids()).toEqual(["a", "b", "c"]);
  });

  it("updateConnection replaces the entry by id (edit)", async () => {
    await startWith({ connections: [makeConnection("a")] });
    useAppStore.getState().updateConnection({ ...makeConnection("a"), name: "Renamed" });
    expect(currentConnectionsView().connections[0].name).toBe("Renamed");

    await expectSettledParity();
    expect(currentConnectionsView().connections[0].name).toBe("Renamed");
  });

  it("deleteConnection drops the connection", async () => {
    await startWith({ connections: [makeConnection("a"), makeConnection("b")] });
    useAppStore.getState().deleteConnection("a");
    expect(ids()).toEqual(["b"]);

    await expectSettledParity();
    expect(ids()).toEqual(["b"]);
  });

  it("bulkDeleteConnections persists one remove per connection", async () => {
    await startWith({
      connections: [makeConnection("a"), makeConnection("b"), makeConnection("c")],
    });
    useAppStore.getState().bulkDeleteConnections(["a", "c"]);
    expect(ids()).toEqual(["b"]);

    await expectSettledParity();
    expect(double.calls).toEqual(["removeConnection", "removeConnection"]);
    expect(ids()).toEqual(["b"]);
  });

  it("duplicateConnection appends a copy", async () => {
    await startWith({ connections: [makeConnection("a")] });
    useAppStore.getState().duplicateConnection("a");
    expect(currentConnectionsView().connections).toHaveLength(2);

    await expectSettledParity();
    const view = currentConnectionsView();
    expect(view.connections).toHaveLength(2);
    expect(view.connections[1].name).toBe("Copy of Conn a");
  });

  it("addFolder appends the folder", async () => {
    useAppStore.getState().addFolder(makeFolder("work"));
    expect(currentConnectionsView().folders[0].id).toBe("work");

    await expectSettledParity();
    expect(double.calls).toEqual(["persistFolder"]);
  });

  it("toggleFolder flips the folder expansion", async () => {
    await startWith({ folders: [makeFolder("work", null, false)] });
    useAppStore.getState().toggleFolder("work");
    expect(currentConnectionsView().folders[0].isExpanded).toBe(true);

    await expectSettledParity();
    expect(currentConnectionsView().folders[0].isExpanded).toBe(true);
  });

  it("a rapid double toggle ends where it started (set-shaped overlays)", async () => {
    await startWith({ folders: [makeFolder("work", null, false)] });
    useAppStore.getState().toggleFolder("work");
    useAppStore.getState().toggleFolder("work");
    expect(currentConnectionsView().folders[0].isExpanded).toBe(false);

    await expectSettledParity();
    expect(currentConnectionsView().folders[0].isExpanded).toBe(false);
  });

  it("moveConnectionToFolder sets the connection's folderId", async () => {
    await startWith({ folders: [makeFolder("work")], connections: [makeConnection("a")] });
    useAppStore.getState().moveConnectionToFolder("a", "work");
    expect(currentConnectionsView().connections[0].folderId).toBe("work");

    await expectSettledParity();
    expect(currentConnectionsView().connections[0].folderId).toBe("work");
  });

  it("moveConnectionToFolder to root (null) clears the folderId", async () => {
    await startWith({ folders: [makeFolder("work")], connections: [makeConnection("a", "work")] });
    useAppStore.getState().moveConnectionToFolder("a", null);
    expect(currentConnectionsView().connections[0].folderId).toBeNull();

    await expectSettledParity();
    expect(currentConnectionsView().connections[0].folderId).toBeNull();
  });

  it("bulkMoveConnectionsToFolder persists one move per connection", async () => {
    await startWith({
      folders: [makeFolder("work")],
      connections: [makeConnection("a"), makeConnection("b")],
    });
    useAppStore.getState().bulkMoveConnectionsToFolder(["a", "b"], "work");
    expect(currentConnectionsView().connections.every((c) => c.folderId === "work")).toBe(true);

    await expectSettledParity();
    expect(double.calls).toEqual(["persistConnection", "persistConnection"]);
    expect(currentConnectionsView().connections.every((c) => c.folderId === "work")).toBe(true);
  });

  it("reorderConnections reorders siblings and persists the new order (#2594)", async () => {
    await startWith({
      folders: [makeFolder("work")],
      connections: [
        makeConnection("a", "work"),
        makeConnection("b", "work"),
        makeConnection("c", "work"),
      ],
    });
    // Drag the last connection (index 2) above the first (index 0): c, a, b.
    useAppStore.getState().reorderConnections(2, 0);
    expect(ids()).toEqual(["c", "a", "b"]);

    await expectSettledParity();
    expect(ids()).toEqual(["c", "a", "b"]);
    // The full new id order is persisted to disk so it survives a reload.
    expect(vi.mocked(apiReorderConnections)).toHaveBeenCalledWith(["c", "a", "b"]);
  });

  it("reorderConnections is a no-op for an out-of-range or identity move", async () => {
    await startWith({ connections: [makeConnection("a"), makeConnection("b")] });

    useAppStore.getState().reorderConnections(0, 0);
    useAppStore.getState().reorderConnections(0, 5);

    expect(vi.mocked(apiReorderConnections)).not.toHaveBeenCalled();
    await expectSettledParity();
    expect(ids()).toEqual(["a", "b"]);
  });

  it("moveConnectionToFile moves the connection to the external file", async () => {
    await startWith({ connections: [makeConnection("a")] });

    await useAppStore.getState().moveConnectionToFile("a", "extra.json");

    // Settled when the action resolves: the region already carries the move.
    expect(currentConnectionsView().connections[0].sourceFile).toBe("extra.json");
    await expectSettledParity();
  });

  it("saveConnectionToFile resolves with the region already holding the save", async () => {
    await startWith({ connections: [makeConnection("a")] });

    const saved = await useAppStore
      .getState()
      .saveConnectionToFile({ ...makeConnection("a"), name: "Edited" }, null);

    expect(saved?.name).toBe("Edited");
    expect(currentConnectionsView().connections[0].name).toBe("Edited");
    await expectSettledParity();
  });

  it("deleteFolder removes the folder, re-homing children to root and reparenting subfolders", async () => {
    await startWith({
      folders: [makeFolder("parent"), makeFolder("work", "parent"), makeFolder("child", "work")],
      connections: [makeConnection("a", "work")],
    });
    useAppStore.getState().deleteFolder("work");

    await expectSettledParity();
    const view = currentConnectionsView();
    expect(view.folders.map((f) => f.id).sort()).toEqual(["child", "parent"]);
    // The subfolder reparents to the removed folder's own parent.
    expect(view.folders.find((f) => f.id === "child")?.parentId).toBe("parent");
    // The child connection moves to root.
    expect(view.connections[0].folderId).toBeNull();
  });

  it("a full tree lifecycle stays in parity across every step", async () => {
    useAppStore.getState().addFolder(makeFolder("work"));
    await expectSettledParity();
    useAppStore.getState().addConnection(makeConnection("a"));
    await expectSettledParity();
    useAppStore.getState().moveConnectionToFolder("a", "work");
    await expectSettledParity();
    useAppStore.getState().updateConnection({ ...makeConnection("a", "work"), name: "Edited" });
    await expectSettledParity();
    useAppStore.getState().toggleFolder("work");
    await expectSettledParity();
    useAppStore.getState().deleteConnection("a");
    await expectSettledParity();
    useAppStore.getState().deleteFolder("work");
    await expectSettledParity();
    expect(currentConnectionsView()).toEqual({ folders: [], connections: [] });
  });
});
