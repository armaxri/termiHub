/**
 * Connections lifecycle — region-authoritative (#2225 PR B, part of #2139 and
 * #2153).
 *
 * The connection-tree lifecycle actions are thin backend-command wrappers: each
 * dispatches its granular `connection.*` intent (the optimistic write) and calls a
 * persist command whose server-side fold reconciles the truth. `appStore` holds no
 * `connections` / `folders` slice.
 *
 * These tests drive the real `appStore` actions against a faithful in-memory port
 * of the Rust `ConnectionsStore` (mirroring `connections_projection/store.rs`) and
 * assert that every action dispatches the right intent and that the reconstructed
 * region view — which the bridge caches and every reader sources via
 * {@link currentConnectionsView} — reflects the transition exactly.
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
  persistAgent: vi.fn(() => Promise.resolve()),
  removeAgent: vi.fn(() => Promise.resolve()),
  reorderAgents: vi.fn(() => Promise.resolve()),
  reorderConnections: vi.fn(() => Promise.resolve()),
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
  getConnectionTypes: vi.fn(() => Promise.resolve([])),
}));

import { useAppStore } from "./appStore";
import {
  moveConnectionToFile as apiMoveConnectionToFile,
  reorderConnections as apiReorderConnections,
} from "@/services/storage";
import {
  currentConnectionsView,
  ensureConnectionsSubscribed,
  setConnectionTransportForTest,
  stopConnectionsSubscription,
} from "./connectionsBridge";
import type { ConnectionFolder, SavedConnection } from "@/types/connection";
import type {
  FrameHandler,
  Intent,
  IntentAck,
  ProjectionFrame,
  SnapshotFrame,
  Subscription,
  Transport,
} from "@/services/transport";

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

interface RegionView {
  folders: ConnectionFolder[];
  connections: SavedConnection[];
}

/**
 * An in-memory substrate double that applies the granular `connection.*` intents
 * with the same semantics as the Rust `ConnectionsStore`, so a run of the real
 * `appStore` actions (which mirror those intents) reconstructs the region view the
 * connection tree sidebar would render. Only `connection.replace` (the render-cut
 * mirror) is intentionally not applied here — the mutation cut drives the region
 * through the per-transition intents.
 */
class ConnectionsStoreTransport implements Transport {
  dispatched: Intent[] = [];
  private folders: ConnectionFolder[] = [];
  private connections: SavedConnection[] = [];
  private version = 0;
  private handlers: FrameHandler[] = [];

  async dispatch(intent: Intent): Promise<IntentAck> {
    this.dispatched.push(intent);
    this.apply(intent);
    this.version += 1;
    this.fan();
    return {
      intentId: intent.intentId,
      status: "accepted",
      produced: [{ region: "connections", version: this.version }],
    };
  }

  private apply(intent: Intent): void {
    const p = intent.payload as Record<string, unknown>;
    switch (intent.kind) {
      case "connection.add": {
        this.connections.push(structuredClone(p.connection as SavedConnection));
        break;
      }
      case "connection.update": {
        const next = p.connection as SavedConnection;
        this.connections = this.connections.map((c) =>
          c.id === next.id ? structuredClone(next) : c
        );
        break;
      }
      case "connection.remove": {
        const id = p.connectionId as string;
        this.connections = this.connections.filter((c) => c.id !== id);
        break;
      }
      case "connection.move": {
        const id = p.connectionId as string;
        const folderId = typeof p.folderId === "string" ? p.folderId : null;
        const c = this.connections.find((c) => c.id === id);
        if (c) c.folderId = folderId;
        break;
      }
      case "connection.reorder": {
        const oldIndex = p.oldIndex as number;
        const newIndex = p.newIndex as number;
        if (
          oldIndex >= 0 &&
          newIndex >= 0 &&
          oldIndex < this.connections.length &&
          newIndex < this.connections.length
        ) {
          const [moved] = this.connections.splice(oldIndex, 1);
          this.connections.splice(newIndex, 0, moved);
        }
        break;
      }
      case "connection.addFolder": {
        this.folders.push(structuredClone(p.folder as ConnectionFolder));
        break;
      }
      case "connection.removeFolder": {
        const folderId = p.folderId as string;
        const parentId = this.folders.find((f) => f.id === folderId)?.parentId ?? null;
        for (const c of this.connections) {
          if (c.folderId === folderId) c.folderId = null;
        }
        for (const f of this.folders) {
          if (f.parentId === folderId) f.parentId = parentId;
        }
        this.folders = this.folders.filter((f) => f.id !== folderId);
        break;
      }
      case "connection.toggleFolder": {
        const folderId = p.folderId as string;
        const f = this.folders.find((f) => f.id === folderId);
        if (f) f.isExpanded = !f.isExpanded;
        break;
      }
      default:
        break;
    }
  }

  /** The reconstructed region view, twin of the store snapshot. */
  regionView(): RegionView {
    return structuredClone({ folders: this.folders, connections: this.connections });
  }

  kinds(): string[] {
    return this.dispatched.map((i) => i.kind);
  }

  async subscribe(region: string, onFrame: FrameHandler): Promise<Subscription> {
    this.handlers.push(onFrame);
    return {
      snapshot: this.snapshot(region),
      unsubscribe: () => {
        this.handlers = this.handlers.filter((h) => h !== onFrame);
      },
    };
  }

  async resync(): Promise<SnapshotFrame | null> {
    return null;
  }

  private snapshot(region: string): SnapshotFrame {
    return { kind: "snapshot", region, version: this.version, view: this.regionView() };
  }

  private fan(): void {
    const frame: ProjectionFrame = this.snapshot("connections");
    for (const h of this.handlers) h(frame);
  }
}

let transport: ConnectionsStoreTransport;

/**
 * Assert the region the intents reconstruct equals the bridge's cached view — the
 * single source every reader now renders from ({@link currentConnectionsView}).
 */
function expectParity() {
  const region = transport.regionView();
  const view = currentConnectionsView();
  expect(region.folders).toEqual(view.folders);
  expect(region.connections).toEqual(view.connections);
}

beforeEach(async () => {
  useAppStore.setState(useAppStore.getInitialState());
  vi.clearAllMocks();
  transport = new ConnectionsStoreTransport();
  setConnectionTransportForTest(transport);
  // Subscribe the bridge to the store double so its dispatched-intent fan-outs
  // update the cached view every reader (and this test's parity check) reads.
  await ensureConnectionsSubscribed();
});

afterEach(() => {
  stopConnectionsSubscription();
  setConnectionTransportForTest(null);
});

describe("connections lifecycle — region reflects every action", () => {
  it("addConnection reproduces the fresh connection entry", () => {
    useAppStore.getState().addConnection(makeConnection("a"));

    expect(transport.kinds()).toEqual(["connection.add"]);
    expectParity();
    expect(transport.regionView().connections[0].id).toBe("a");
  });

  it("bulkAddConnections fans out one add per connection", () => {
    useAppStore
      .getState()
      .bulkAddConnections([makeConnection("a"), makeConnection("b"), makeConnection("c")]);

    expect(transport.kinds()).toEqual(["connection.add", "connection.add", "connection.add"]);
    expectParity();
    expect(transport.regionView().connections.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("updateConnection replaces the entry by id (edit)", () => {
    useAppStore.getState().addConnection(makeConnection("a"));
    useAppStore.getState().updateConnection({ ...makeConnection("a"), name: "Renamed" });

    expectParity();
    expect(transport.regionView().connections[0].name).toBe("Renamed");
    expect(transport.kinds()).toContain("connection.update");
  });

  it("deleteConnection drops the connection from the region", () => {
    useAppStore.getState().addConnection(makeConnection("a"));
    useAppStore.getState().addConnection(makeConnection("b"));

    useAppStore.getState().deleteConnection("a");

    expectParity();
    expect(transport.regionView().connections.map((c) => c.id)).toEqual(["b"]);
    expect(transport.kinds()).toContain("connection.remove");
  });

  it("bulkDeleteConnections fans out one remove per connection", () => {
    useAppStore
      .getState()
      .bulkAddConnections([makeConnection("a"), makeConnection("b"), makeConnection("c")]);

    useAppStore.getState().bulkDeleteConnections(["a", "c"]);

    expectParity();
    expect(transport.regionView().connections.map((c) => c.id)).toEqual(["b"]);
    expect(transport.kinds().filter((k) => k === "connection.remove")).toHaveLength(2);
  });

  it("duplicateConnection appends a copy to the region", () => {
    useAppStore.getState().addConnection(makeConnection("a"));

    useAppStore.getState().duplicateConnection("a");

    expectParity();
    const view = transport.regionView();
    expect(view.connections).toHaveLength(2);
    expect(view.connections[1].name).toBe("Copy of Conn a");
  });

  it("addFolder appends the folder to the region", () => {
    useAppStore.getState().addFolder(makeFolder("work"));

    expect(transport.kinds()).toEqual(["connection.addFolder"]);
    expectParity();
    expect(transport.regionView().folders[0].id).toBe("work");
  });

  it("toggleFolder flips the projected folder expansion", () => {
    useAppStore.getState().addFolder(makeFolder("work", null, false));

    useAppStore.getState().toggleFolder("work");

    expectParity();
    expect(transport.regionView().folders[0].isExpanded).toBe(true);
    expect(transport.kinds()).toContain("connection.toggleFolder");
  });

  it("moveConnectionToFolder sets the connection's folderId in the region", () => {
    useAppStore.getState().addFolder(makeFolder("work"));
    useAppStore.getState().addConnection(makeConnection("a"));

    useAppStore.getState().moveConnectionToFolder("a", "work");

    expectParity();
    expect(transport.regionView().connections[0].folderId).toBe("work");
    expect(transport.kinds()).toContain("connection.move");
  });

  it("moveConnectionToFolder to root (null) clears the folderId in the region", () => {
    useAppStore.getState().addFolder(makeFolder("work"));
    useAppStore.getState().addConnection(makeConnection("a", "work"));

    useAppStore.getState().moveConnectionToFolder("a", null);

    expectParity();
    expect(transport.regionView().connections[0].folderId).toBeNull();
  });

  it("bulkMoveConnectionsToFolder fans out one move per connection", () => {
    useAppStore.getState().addFolder(makeFolder("work"));
    useAppStore.getState().bulkAddConnections([makeConnection("a"), makeConnection("b")]);

    useAppStore.getState().bulkMoveConnectionsToFolder(["a", "b"], "work");

    expectParity();
    expect(transport.regionView().connections.every((c) => c.folderId === "work")).toBe(true);
    expect(transport.kinds().filter((k) => k === "connection.move")).toHaveLength(2);
  });

  it("reorderConnections reorders siblings in the region and persists the new order (#2594)", () => {
    useAppStore.getState().addFolder(makeFolder("work"));
    useAppStore
      .getState()
      .bulkAddConnections([
        makeConnection("a", "work"),
        makeConnection("b", "work"),
        makeConnection("c", "work"),
      ]);

    // Drag the last connection (index 2) above the first (index 0): c, a, b.
    useAppStore.getState().reorderConnections(2, 0);

    expectParity();
    expect(transport.regionView().connections.map((c) => c.id)).toEqual(["c", "a", "b"]);
    expect(transport.kinds()).toContain("connection.reorder");
    // The full new id order is persisted to disk so it survives a reload.
    expect(vi.mocked(apiReorderConnections)).toHaveBeenCalledWith(["c", "a", "b"]);
  });

  it("reorderConnections is a no-op for an out-of-range or identity move", () => {
    useAppStore.getState().bulkAddConnections([makeConnection("a"), makeConnection("b")]);
    vi.mocked(apiReorderConnections).mockClear();

    useAppStore.getState().reorderConnections(0, 0);
    useAppStore.getState().reorderConnections(0, 5);

    expect(transport.kinds()).not.toContain("connection.reorder");
    expect(vi.mocked(apiReorderConnections)).not.toHaveBeenCalled();
  });

  it("moveConnectionToFile replaces the connection by id (external-file move)", async () => {
    // Seed the region directly (standing in for the server-side fold) so the async
    // action reads the existing entry from the cached view.
    const conn = makeConnection("a");
    transport.dispatch({
      intentId: "seed",
      kind: "connection.add",
      payload: { connection: conn },
      clientId: "seed",
    });
    const updated = { ...conn, sourceFile: "extra.json" };
    vi.mocked(apiMoveConnectionToFile).mockResolvedValue(updated as never);

    await useAppStore.getState().moveConnectionToFile("a", "extra.json");

    expectParity();
    expect(transport.regionView().connections[0].sourceFile).toBe("extra.json");
    expect(transport.kinds()).toContain("connection.update");
  });

  it("deleteFolder removes the folder, re-homing children to root and reparenting subfolders", () => {
    useAppStore.getState().addFolder(makeFolder("parent"));
    useAppStore.getState().addFolder(makeFolder("work", "parent"));
    useAppStore.getState().addFolder(makeFolder("child", "work"));
    useAppStore.getState().addConnection(makeConnection("a", "work"));

    useAppStore.getState().deleteFolder("work");

    expectParity();
    const view = transport.regionView();
    expect(view.folders.map((f) => f.id).sort()).toEqual(["child", "parent"]);
    // The subfolder reparents to the removed folder's own parent.
    expect(view.folders.find((f) => f.id === "child")?.parentId).toBe("parent");
    // The child connection moves to root.
    expect(view.connections[0].folderId).toBeNull();
    expect(transport.kinds()).toContain("connection.removeFolder");
  });

  it("a full tree lifecycle stays in parity across every step", () => {
    useAppStore.getState().addFolder(makeFolder("work"));
    expectParity();
    useAppStore.getState().addConnection(makeConnection("a"));
    expectParity();
    useAppStore.getState().moveConnectionToFolder("a", "work");
    expectParity();
    useAppStore.getState().updateConnection({ ...makeConnection("a", "work"), name: "Edited" });
    expectParity();
    useAppStore.getState().toggleFolder("work");
    expectParity();
    useAppStore.getState().deleteConnection("a");
    expectParity();
    useAppStore.getState().deleteFolder("work");
    expectParity();
    expect(transport.regionView()).toEqual({ folders: [], connections: [] });
  });
});
