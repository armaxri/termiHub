/**
 * Connection-mutation atomicity — region rollback on persist failure (FES-005).
 *
 * Every connection mutation performs two independent authoritative writes: the
 * granular `connection.*` intent (which the backend applies to the in-memory
 * `connections` region immediately) and a separate persist command that writes
 * `connections.json` on disk. They are not coupled: if the intent lands but the
 * persist REJECTS (disk error, permission, read-only external file, race), the
 * region shows the mutation applied while disk does not — and on the next reseed
 * from disk (#2389/#2394) the divergence "resurrects" (a deleted connection
 * reappears) or vanishes (an added connection disappears).
 *
 * These tests fail the persist command and assert the region is **reverted** — the
 * deleted connection reappears / the added one disappears immediately — rather than
 * diverging until reload. They drive the real `appStore` actions against the same
 * faithful in-memory port of the Rust `ConnectionsStore` the mutation-cut parity
 * tests use, so the reconstructed region view is exactly what every reader renders
 * from ({@link currentConnectionsView}).
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
import { persistConnection, removeConnection } from "@/services/storage";
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

interface RegionView {
  folders: ConnectionFolder[];
  connections: SavedConnection[];
}

/**
 * An in-memory substrate double applying the granular `connection.*` intents with
 * the same semantics as the Rust `ConnectionsStore` — the mutation-cut parity
 * double, so the reconstructed region view is what the sidebar renders.
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
      default:
        break;
    }
  }

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

function ids(): string[] {
  return currentConnectionsView().connections.map((c) => c.id);
}

beforeEach(async () => {
  useAppStore.setState(useAppStore.getInitialState());
  vi.clearAllMocks();
  transport = new ConnectionsStoreTransport();
  setConnectionTransportForTest(transport);
  await ensureConnectionsSubscribed();
});

afterEach(() => {
  stopConnectionsSubscription();
  setConnectionTransportForTest(null);
});

describe("connection mutations are atomic — region reverts on persist failure (FES-005)", () => {
  it("deleteConnection reverts (the deleted connection reappears) when the persist rejects", async () => {
    useAppStore.getState().addConnection(makeConnection("a"));
    useAppStore.getState().addConnection(makeConnection("b"));
    expect(ids()).toEqual(["a", "b"]);

    // The on-disk delete fails: the region removed "a" optimistically, but disk
    // still has it. Without a rollback the region diverges and "a" resurrects on
    // the next reseed.
    vi.mocked(removeConnection).mockRejectedValueOnce(new Error("disk read-only"));

    useAppStore.getState().deleteConnection("a");

    // The connection must reappear in the region (reverted to match disk), not stay
    // gone until a reload. The compensating `connection.add` appends, so the
    // transient position may differ (the next disk reseed restores exact order) —
    // assert membership, which is what closes the resurrection gap.
    await vi.waitFor(() => expect([...ids()].sort()).toEqual(["a", "b"]));
  });

  it("duplicateConnection reverts (the copy disappears) when the persist rejects", async () => {
    useAppStore.getState().addConnection(makeConnection("a"));
    expect(currentConnectionsView().connections).toHaveLength(1);

    vi.mocked(persistConnection).mockRejectedValueOnce(new Error("disk full"));

    useAppStore.getState().duplicateConnection("a");
    // The optimistic copy is present immediately.
    expect(currentConnectionsView().connections).toHaveLength(2);

    // Once the persist rejects, the copy must be removed again (never persisted to
    // disk, so it would vanish on reload — revert now to match disk).
    await vi.waitFor(() => expect(currentConnectionsView().connections).toHaveLength(1));
    expect(ids()).toEqual(["a"]);
  });

  it("addConnection reverts (the new connection disappears) when the persist rejects", async () => {
    vi.mocked(persistConnection).mockRejectedValueOnce(new Error("permission denied"));

    useAppStore.getState().addConnection(makeConnection("a"));
    expect(ids()).toEqual(["a"]);

    await vi.waitFor(() => expect(ids()).toEqual([]));
  });

  it("updateConnection reverts to the prior value when the persist rejects", async () => {
    useAppStore.getState().addConnection(makeConnection("a"));
    expect(currentConnectionsView().connections[0].name).toBe("Conn a");

    vi.mocked(persistConnection).mockRejectedValueOnce(new Error("disk error"));

    useAppStore.getState().updateConnection({ ...makeConnection("a"), name: "Renamed" });
    // Optimistically renamed.
    expect(currentConnectionsView().connections[0].name).toBe("Renamed");

    // On persist failure the region must revert to the prior name.
    await vi.waitFor(() => expect(currentConnectionsView().connections[0].name).toBe("Conn a"));
  });

  it("bulkDeleteConnections reverts only the items whose persist rejected", async () => {
    useAppStore
      .getState()
      .bulkAddConnections([makeConnection("a"), makeConnection("b"), makeConnection("c")]);
    expect(ids()).toEqual(["a", "b", "c"]);

    // Only the delete of "b" fails on disk; "a" and "c" persist fine.
    vi.mocked(removeConnection).mockImplementation((id: string) =>
      id === "b" ? Promise.reject(new Error("locked")) : Promise.resolve()
    );

    useAppStore.getState().bulkDeleteConnections(["a", "b", "c"]);

    // "b" must reappear (its persist failed); "a" and "c" stay deleted.
    await vi.waitFor(() => expect(ids()).toEqual(["b"]));
  });

  it("a successful mutation does not revert (no phantom re-add)", async () => {
    useAppStore.getState().addConnection(makeConnection("a"));
    useAppStore.getState().addConnection(makeConnection("b"));

    // removeConnection resolves (default mock): a clean delete stays deleted.
    useAppStore.getState().deleteConnection("a");

    await vi.waitFor(() => expect(ids()).toEqual(["b"]));
    // Give any stray rollback a chance to (wrongly) fire, then re-assert.
    await new Promise((r) => setTimeout(r, 10));
    expect(ids()).toEqual(["b"]);
  });
});
