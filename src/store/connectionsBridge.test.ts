/**
 * Connections bridge — the connections domain is region-authoritative (#2225, PR
 * B). These tests drive the bridge against the in-memory {@link FakeTransport}
 * store double and assert: it subscribes and fans the projected view out to
 * listeners, caches the latest view for synchronous reads, and layers the
 * persist-confirmed optimistic overlay ({@link persistWithOverlay}, #2831) over
 * the authoritative view without ever writing the region itself.
 */
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

import { orderConnections, removeConnection, upsertConnection } from "./connectionsOverlay";
import {
  __emitConnectionsViewForTest,
  CONNECTIONS_REGION,
  currentConnectionsView,
  ensureConnectionsSubscribed,
  onConnectionsView,
  persistWithOverlay,
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
function folder(id: string, parentId: string | null = null, isExpanded = true): ConnectionFolder {
  return { id, name: `F ${id}`, parentId, isExpanded };
}

/**
 * An in-memory substrate double: holds one `connections` view (fed via
 * {@link seed}, standing in for the server-side fold), records every dispatched
 * intent, and fans a fresh snapshot to every subscriber — so subscription fan-out
 * and mutation-cut dispatch are exercised without a backend.
 */
class FakeTransport implements Transport {
  dispatched: Intent[] = [];
  private view: Record<string, unknown> = { folders: [], connections: [] };
  private version = 0;
  private handlers: FrameHandler[] = [];

  /** Feed the region as the server-side fold would, and fan the diff out. */
  seed(view: ConnectionsView): void {
    this.view = { folders: view.folders, connections: view.connections };
    this.version += 1;
    this.fan();
  }

  async dispatch(intent: Intent): Promise<IntentAck> {
    this.dispatched.push(intent);
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

  /**
   * Change the region as a persist's server-side fold would, but keep the diff
   * frame "in flight" (not delivered) — the command resolved before its frame.
   */
  foldInFlight(view: ConnectionsView): void {
    this.view = { folders: view.folders, connections: view.connections };
    this.version += 1;
  }

  resyncs = 0;
  failResync = false;

  async resync(region: string, have?: number): Promise<SnapshotFrame | null> {
    this.resyncs += 1;
    if (this.failResync) throw new Error("transport down");
    return have === this.version ? null : this.snapshot(region);
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
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("subscription + fan-out", () => {
  it("fans the server-fed region view out to listeners and caches it", async () => {
    const received: ConnectionsView[] = [];
    const unsubscribe = onConnectionsView((v) => received.push(v));

    const folders = [folder("Work")];
    const connections = [connection("Work/A", "Work")];
    transport.seed({ folders, connections });
    await ensureConnectionsSubscribed();

    // A synchronous read returns the latest server-fed view…
    expect(currentConnectionsView()).toEqual({ folders, connections });
    // …and the same view was fanned out to the listener.
    expect(received[received.length - 1]).toEqual({ folders, connections });
    unsubscribe();
  });

  it("re-fans on every region diff", async () => {
    const received: ConnectionsView[] = [];
    const unsubscribe = onConnectionsView((v) => received.push(v));
    await ensureConnectionsSubscribed();

    transport.seed({ folders: [folder("A")], connections: [] });
    transport.seed({ folders: [folder("A")], connections: [connection("A/1", "A")] });

    expect(currentConnectionsView().connections).toHaveLength(1);
    expect(received[received.length - 1].connections[0].id).toBe("A/1");
    unsubscribe();
  });
});

describe("version guard (FES-006)", () => {
  it("applies the first snapshot, then a newer one, and drops a stale older one", () => {
    const received: ConnectionsView[] = [];
    const unsubscribe = onConnectionsView((v) => received.push(v));

    const v1: ConnectionsView = { folders: [folder("A")], connections: [] };
    const v2: ConnectionsView = { folders: [folder("A")], connections: [connection("A/1", "A")] };
    const stale: ConnectionsView = { folders: [folder("Z")], connections: [] };

    // First snapshot always applies.
    __emitConnectionsViewForTest(v1, 1);
    expect(currentConnectionsView()).toEqual(v1);

    // A strictly newer version applies.
    __emitConnectionsViewForTest(v2, 2);
    expect(currentConnectionsView()).toEqual(v2);

    // A strictly older (stale, out-of-order) version is dropped — the newer view stays.
    __emitConnectionsViewForTest(stale, 1);
    expect(currentConnectionsView()).toEqual(v2);
    expect(received[received.length - 1]).toEqual(v2);

    unsubscribe();
  });
});

describe("persistWithOverlay — the persist is the single region writer (#2831)", () => {
  const a = connection("A");
  const b = connection("B");
  const c = connection("C");

  beforeEach(async () => {
    transport.seed({ folders: [], connections: [a, b, c] });
    await ensureConnectionsSubscribed();
  });

  const ids = () => currentConnectionsView().connections.map((x) => x.id);

  /** A persist whose settling the test controls. */
  function deferred<T = void>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it("shows the overlay synchronously and dispatches no region intent", () => {
    const persist = deferred();
    void persistWithOverlay(removeConnection("A"), () => persist.promise);
    expect(ids()).toEqual(["B", "C"]);
    expect(transport.dispatched).toEqual([]);
    persist.resolve();
  });

  it("on success, settles onto the persisted region with no gap, even before its frame lands", async () => {
    const persist = deferred();
    const done = persistWithOverlay(
      upsertConnection(connection("conn-tmp")),
      () => persist.promise
    );
    expect(ids()).toEqual(["A", "B", "C", "conn-tmp"]);

    // The command persisted under a recomputed id and folded it; its frame is
    // still in flight when the command resolves.
    transport.foldInFlight({ folders: [], connections: [a, b, c, connection("New")] });
    persist.resolve();
    await done;

    expect(ids()).toEqual(["A", "B", "C", "New"]); // no optimistic row, no duplicate
    expect(transport.dispatched).toEqual([]);
  });

  it("Done-when: a failed persist leaves the view byte-identical to disk, order included, with no compensating write", async () => {
    const disk = structuredClone(currentConnectionsView());
    const persist = deferred();
    const done = persistWithOverlay(removeConnection("A"), () => persist.promise);
    expect(ids()).toEqual(["B", "C"]);

    persist.reject(new Error("disk read-only"));
    await expect(done).rejects.toThrow("disk read-only");

    // "A" is back exactly where disk has it (first), not appended.
    expect(currentConnectionsView()).toEqual(disk);
    expect(ids()).toEqual(["A", "B", "C"]);
    expect(transport.dispatched).toEqual([]);
  });

  it("a failed persist that partly reached disk shows exactly what disk holds", async () => {
    const persist = deferred();
    const done = persistWithOverlay(orderConnections(["C", "B", "A"]), () => persist.promise);
    expect(ids()).toEqual(["C", "B", "A"]);

    // Half the reorder reached disk before a later step failed; the backend
    // re-folded that disk truth.
    transport.foldInFlight({ folders: [], connections: [b, a, c] });
    persist.reject(new Error("later step failed"));
    await expect(done).rejects.toThrow();

    expect(ids()).toEqual(["B", "A", "C"]);
  });

  it("treats a synchronous throw from the persist as a rejection", async () => {
    const done = persistWithOverlay(removeConnection("A"), () => {
      throw new Error("no transport");
    });
    await expect(done).rejects.toThrow("no transport");
    expect(ids()).toEqual(["A", "B", "C"]);
  });

  it("settles overlays independently", async () => {
    const first = deferred();
    const second = deferred();
    const one = persistWithOverlay(removeConnection("A"), () => first.promise);
    void persistWithOverlay(removeConnection("B"), () => second.promise);
    expect(ids()).toEqual(["C"]);

    first.reject(new Error("locked"));
    await expect(one).rejects.toThrow();
    expect(ids()).toEqual(["A", "C"]); // "B" still pending, still hidden
    second.resolve();
  });

  it("never strands an overlay when the catch-up itself fails", async () => {
    transport.failResync = true;
    await expect(
      persistWithOverlay(removeConnection("A"), () => Promise.reject(new Error("x")))
    ).rejects.toThrow("x");
    expect(ids()).toEqual(["A", "B", "C"]);
  });

  it("with no overlay the view is the authoritative region itself", async () => {
    await persistWithOverlay(removeConnection("A"), async () => {
      transport.seed({ folders: [], connections: [b, c] });
    });
    expect(ids()).toEqual(["B", "C"]);
    await flush();
    expect(ids()).toEqual(["B", "C"]);
  });
});
