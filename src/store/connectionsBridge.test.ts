import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  FrameHandler,
  Intent,
  IntentAck,
  ProjectionFrame,
  SnapshotFrame,
  Subscription,
  Transport,
} from "@/services/transport";
import type { ConnectionFolder, SavedConnection } from "@/types/connection";

import {
  CONNECTIONS_REGION,
  connectionRenderFromProjectionEnabled,
  connectionsViewMirrors,
  currentConnectionsView,
  deepEqual,
  ensureConnectionsSubscribed,
  onConnectionsView,
  seedConnectionsRegion,
  setConnectionRenderFromProjectionEnabled,
  setConnectionTransportForTest,
  stopConnectionsSubscription,
  type ConnectionsView,
} from "./connectionsBridge";

/** A deterministic saved connection, optionally inside a folder. */
function connection(id: string, folderId: string | null = null): SavedConnection {
  return {
    id,
    name: `Conn ${id}`,
    config: { type: "ssh", host: `h-${id}`, port: 22 } as never,
    folderId,
  };
}

/** A deterministic folder, optionally nested under a parent. */
function folder(
  id: string,
  parentId: string | null = null,
  isExpanded = true
): ConnectionFolder {
  return { id, name: `F ${id}`, parentId, isExpanded };
}

/**
 * An in-memory substrate double: holds one `connections` view, applies a
 * `connection.replace` intent by overwriting the view from its payload (keyed to
 * the Rust snapshot shape `folders`/`connections`), and fans a fresh snapshot to
 * every subscriber — so the seed round-trip and multi-subscriber fan-out are
 * exercised without a backend.
 */
class FakeTransport implements Transport {
  dispatched: Intent[] = [];
  private view: Record<string, unknown> = { folders: [], connections: [] };
  private version = 0;
  private handlers: FrameHandler[] = [];

  async dispatch(intent: Intent): Promise<IntentAck> {
    this.dispatched.push(intent);
    if (intent.kind === "connection.replace") {
      const p = intent.payload as Record<string, unknown>;
      this.view = { folders: p.folders ?? [], connections: p.connections ?? [] };
      this.version += 1;
      this.fan();
      return {
        intentId: intent.intentId,
        status: "accepted",
        produced: [{ region: CONNECTIONS_REGION, version: this.version }],
      };
    }
    return { intentId: intent.intentId, status: "accepted", produced: [] };
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
    return { kind: "snapshot", region, version: this.version, view: structuredClone(this.view) };
  }

  private fan(): void {
    const frame: ProjectionFrame = this.snapshot(CONNECTIONS_REGION);
    for (const h of this.handlers) h(frame);
  }
}

let transport: FakeTransport;

beforeEach(() => {
  transport = new FakeTransport();
  setConnectionTransportForTest(transport);
});

afterEach(() => {
  stopConnectionsSubscription();
  setConnectionTransportForTest(null);
  setConnectionRenderFromProjectionEnabled(null);
});

describe("connectionRenderFromProjectionEnabled flag", () => {
  it("defaults on and honours the programmatic override", () => {
    expect(connectionRenderFromProjectionEnabled()).toBe(true);
    setConnectionRenderFromProjectionEnabled(false);
    expect(connectionRenderFromProjectionEnabled()).toBe(false);
    setConnectionRenderFromProjectionEnabled(true);
    expect(connectionRenderFromProjectionEnabled()).toBe(true);
    setConnectionRenderFromProjectionEnabled(null);
    expect(connectionRenderFromProjectionEnabled()).toBe(true);
  });
});

describe("deepEqual", () => {
  it("treats an integer and its float round-trip as equal", () => {
    expect(deepEqual(22, 22.0)).toBe(true);
    expect(deepEqual({ a: [1, 2] }, { a: [1, 2] })).toBe(true);
  });

  it("distinguishes differing values, key sets, and null", () => {
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqual(null, {})).toBe(false);
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
  });
});

describe("connectionsViewMirrors", () => {
  const folders = [folder("Work")];
  const connections = [connection("Work/A", "Work")];

  it("is false for an undefined view", () => {
    expect(connectionsViewMirrors(undefined, folders, connections)).toBe(false);
  });

  it("is true when the view value-matches the appStore slice", () => {
    const view: ConnectionsView = {
      folders: structuredClone(folders),
      connections: structuredClone(connections),
    };
    expect(connectionsViewMirrors(view, folders, connections)).toBe(true);
  });

  it("is false when a folder's isExpanded diverges", () => {
    const view: ConnectionsView = {
      folders: [{ ...folders[0], isExpanded: false }],
      connections,
    };
    expect(connectionsViewMirrors(view, folders, connections)).toBe(false);
  });

  it("is false when a connection's folderId diverges", () => {
    const view: ConnectionsView = {
      folders,
      connections: [{ ...connections[0], folderId: null }],
    };
    expect(connectionsViewMirrors(view, folders, connections)).toBe(false);
  });

  it("is false when the folder order diverges", () => {
    const two = [folder("A"), folder("B")];
    const view: ConnectionsView = { folders: [folder("B"), folder("A")], connections: [] };
    expect(connectionsViewMirrors(view, two, [])).toBe(false);
  });
});

describe("seedConnectionsRegion", () => {
  it("dispatches connection.replace carrying the whole slice, keyed to the Rust shape", async () => {
    const folders = [folder("Work")];
    const connections = [connection("Work/A", "Work")];
    await seedConnectionsRegion(folders, connections);
    expect(transport.dispatched).toHaveLength(1);
    expect(transport.dispatched[0]).toMatchObject({
      kind: "connection.replace",
      payload: { folders, connections },
    });
  });

  it("de-dupes an identical slice but re-seeds after a change", async () => {
    const folders = [folder("Work")];
    await seedConnectionsRegion(folders, []);
    await seedConnectionsRegion(folders, []);
    expect(transport.dispatched).toHaveLength(1);

    const changed = [folder("Work", null, false)];
    await seedConnectionsRegion(changed, []);
    expect(transport.dispatched).toHaveLength(2);
  });
});

describe("seed round-trip → the region mirrors appStore", () => {
  it("makes the projected view a faithful mirror of the seeded slice", async () => {
    const received: ConnectionsView[] = [];
    const unsubscribe = onConnectionsView((v) => received.push(v));
    await ensureConnectionsSubscribed();

    const folders = [folder("Work")];
    const connections = [connection("Work/A", "Work")];
    await seedConnectionsRegion(folders, connections);

    // The region now carries the seeded slice and the gate accepts it.
    expect(connectionsViewMirrors(currentConnectionsView(), folders, connections)).toBe(true);
    expect(received[received.length - 1]).toEqual({ folders, connections });
    unsubscribe();
  });
});
