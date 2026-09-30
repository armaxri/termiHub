/**
 * Connection-mutation atomicity — the persist command is the single region
 * writer (FES-005, #2831).
 *
 * Every connection/folder mutation used to perform two uncoupled backend writes:
 * a granular `connection.*` intent (applied to the region at once) and a separate
 * persist command (writing `connections.json`). A failed persist left the region
 * ahead of disk, and the FES-005 fix papered over it with a client-side
 * compensating intent — a second write that re-appended a reverted delete, so
 * the exact position drifted until the next reseed.
 *
 * Now the persist command is the only writer: it writes disk and folds disk
 * into the region in one backend step, success or failure, while the client
 * shows a local optimistic overlay until the persist settles. These tests drive
 * the real `appStore` actions against {@link ConnectionsBackendDouble} (a
 * faithful disk + region + `commit` double), fail each mutation's persist, and
 * assert the Done-when of #2831:
 *
 * - the region every reader renders ({@link currentConnectionsView}) is
 *   **byte-identical to disk** — membership and exact order;
 * - there was **no compensating write**: no `connection.*` intent at all, and
 *   the backend region version never moved for a failure that left disk as is.
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
import {
  currentConnectionsView,
  ensureConnectionsSubscribed,
  setConnectionTransportForTest,
  stopConnectionsSubscription,
} from "./connectionsBridge";
import type { ConnectionFolder, SavedConnection } from "@/types/connection";

function conn(id: string, folderId: string | null = null): SavedConnection {
  return {
    id,
    name: `Conn ${id}`,
    config: { type: "ssh", config: { host: `h-${id}`, port: 22 } } as never,
    folderId,
  };
}

function folder(id: string, parentId: string | null = null, isExpanded = true): ConnectionFolder {
  return { id, name: `F ${id}`, parentId, isExpanded };
}

/** The tree on disk when each test starts. */
const DISK = {
  folders: [folder("parent"), folder("work", "parent"), folder("child", "work")],
  connections: [conn("a", "work"), conn("b"), conn("c"), conn("d", "work")],
};

let double: ConnectionsBackendDouble;

/** Let every in-flight persist settle and every fold frame land. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
}

/**
 * The Done-when assertion: the region every reader sees is byte-identical to
 * disk — order included — and nothing but the persist command wrote it.
 */
function expectRegionEqualsDisk(): void {
  expect(currentConnectionsView()).toEqual(double.diskView());
  expect(double.regionView()).toEqual(double.diskView());
  expect(double.dispatched).toEqual([]);
}

beforeEach(async () => {
  useAppStore.setState(useAppStore.getInitialState());
  vi.clearAllMocks();
  double = new ConnectionsBackendDouble(DISK);
  backend.current = double;
  setConnectionTransportForTest(double);
  await ensureConnectionsSubscribed();
  expectRegionEqualsDisk();
});

afterEach(() => {
  stopConnectionsSubscription();
  setConnectionTransportForTest(null);
  backend.current = null;
});

/**
 * Every mutation #2831 lists (plus the add/update/delete family PR #2830
 * covered), each with the persist command it goes through and the optimistic
 * change it must show before the persist settles.
 */
const MUTATIONS: Array<{
  name: string;
  command: Parameters<ConnectionsBackendDouble["failNext"]>[0];
  run: () => unknown;
  optimistic: () => void;
}> = [
  {
    name: "addConnection",
    command: "persistConnection",
    run: () => useAppStore.getState().addConnection(conn("new")),
    optimistic: () => expect(ids()).toContain("new"),
  },
  {
    name: "bulkAddConnections",
    command: "persistConnection",
    run: () => useAppStore.getState().bulkAddConnections([conn("new")]),
    optimistic: () => expect(ids()).toContain("new"),
  },
  {
    name: "updateConnection",
    command: "persistConnection",
    run: () => useAppStore.getState().updateConnection({ ...conn("b"), name: "Renamed" }),
    optimistic: () => expect(byId("b")?.name).toBe("Renamed"),
  },
  {
    name: "deleteConnection",
    command: "removeConnection",
    run: () => useAppStore.getState().deleteConnection("a"),
    optimistic: () => expect(ids()).not.toContain("a"),
  },
  {
    name: "bulkDeleteConnections",
    command: "removeConnection",
    run: () => useAppStore.getState().bulkDeleteConnections(["a"]),
    optimistic: () => expect(ids()).not.toContain("a"),
  },
  {
    name: "duplicateConnection",
    command: "persistConnection",
    run: () => useAppStore.getState().duplicateConnection("b"),
    optimistic: () => expect(ids()).toHaveLength(5),
  },
  {
    name: "moveConnectionToFolder",
    command: "persistConnection",
    run: () => useAppStore.getState().moveConnectionToFolder("b", "work"),
    optimistic: () => expect(byId("b")?.folderId).toBe("work"),
  },
  {
    name: "bulkMoveConnectionsToFolder",
    command: "persistConnection",
    run: () => useAppStore.getState().bulkMoveConnectionsToFolder(["b"], "work"),
    optimistic: () => expect(byId("b")?.folderId).toBe("work"),
  },
  {
    name: "reorderConnections",
    command: "reorderConnections",
    run: () => useAppStore.getState().reorderConnections(3, 0),
    optimistic: () => expect(ids()).toEqual(["d", "a", "b", "c"]),
  },
  {
    name: "moveConnectionToFile",
    command: "moveConnectionToFile",
    run: () => useAppStore.getState().moveConnectionToFile("b", "extra.json"),
    optimistic: () => expect(byId("b")?.sourceFile).toBe("extra.json"),
  },
  {
    name: "saveConnectionToFile",
    command: "saveConnectionToFile",
    run: () =>
      useAppStore
        .getState()
        .saveConnectionToFile({ ...conn("b"), name: "Moved", sourceFile: "extra.json" }, null),
    optimistic: () => expect(byId("b")?.name).toBe("Moved"),
  },
  {
    name: "addFolder",
    command: "persistFolder",
    run: () => useAppStore.getState().addFolder(folder("new")),
    optimistic: () => expect(folderIds()).toContain("new"),
  },
  {
    name: "deleteFolder",
    command: "removeFolder",
    run: () => useAppStore.getState().deleteFolder("work"),
    optimistic: () => expect(folderIds()).not.toContain("work"),
  },
  {
    name: "toggleFolder",
    command: "persistFolder",
    run: () => useAppStore.getState().toggleFolder("work"),
    optimistic: () =>
      expect(currentConnectionsView().folders.find((f) => f.id === "work")?.isExpanded).toBe(false),
  },
];

function ids(): string[] {
  return currentConnectionsView().connections.map((c) => c.id);
}

function folderIds(): string[] {
  return currentConnectionsView().folders.map((f) => f.id);
}

function byId(id: string): SavedConnection | undefined {
  return currentConnectionsView().connections.find((c) => c.id === id);
}

describe("a failed persist leaves the region byte-identical to disk, with no compensating write (#2831)", () => {
  it.each(MUTATIONS)("$name", async ({ command, run, optimistic }) => {
    const disk = double.diskView();
    const version = double.regionVersion();
    double.failNext(command, new Error("disk read-only"));

    run();
    // Instant optimistic feedback, before the persist settles.
    optimistic();

    await settle();

    expectRegionEqualsDisk();
    // Disk did not change, and neither did the region: exact order, and no
    // write of any kind reached the backend region.
    expect(currentConnectionsView()).toEqual(disk);
    expect(double.regionVersion()).toBe(version);
  });
});

describe("a successful persist lands through the fold alone (#2831)", () => {
  it.each(MUTATIONS)("$name", async ({ command, run, optimistic }) => {
    run();
    optimistic();

    await settle();

    expect(double.calls).toContain(command);
    expectRegionEqualsDisk();
    optimistic(); // the persisted change is now the authoritative one
  });
});

describe("partial failures and batches (#2831)", () => {
  it("a delete that fails keeps the connection at its exact on-disk position", async () => {
    double.failNext("removeConnection", new Error("locked"));
    useAppStore.getState().deleteConnection("b");
    expect(ids()).toEqual(["a", "c", "d"]);

    await settle();

    // Not re-appended at the end (the old compensating add): exactly where disk has it.
    expect(ids()).toEqual(["a", "b", "c", "d"]);
    expectRegionEqualsDisk();
  });

  it("a failure after part of the write reached disk shows exactly that part", async () => {
    // The reorder reached disk only half-way before a later step failed.
    double.failNext("reorderConnections", new Error("later step failed"), {
      partial: (disk) => ({
        folders: disk.folders,
        connections: [disk.connections[1], disk.connections[0], ...disk.connections.slice(2)],
      }),
    });
    useAppStore.getState().reorderConnections(3, 0);

    await settle();

    expect(ids()).toEqual(["b", "a", "c", "d"]);
    expectRegionEqualsDisk();
  });

  it("bulkDeleteConnections keeps exactly the items whose persist failed, in order", async () => {
    double.failNext("removeConnection", new Error("locked"), { id: "c" });

    useAppStore.getState().bulkDeleteConnections(["a", "c", "d"]);
    expect(ids()).toEqual(["b"]);

    await settle();

    expect(ids()).toEqual(["b", "c"]);
    expectRegionEqualsDisk();
  });

  it("a successful delete stays deleted (no phantom re-add)", async () => {
    useAppStore.getState().deleteConnection("a");
    await settle();
    expect(ids()).toEqual(["b", "c", "d"]);
    expectRegionEqualsDisk();
  });
});
