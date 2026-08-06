/**
 * Connections bridge — the connection tree sidebar is region-authoritative (#2225,
 * PR A). These tests drive the bridge against the in-memory {@link FakeTransport}
 * store double and assert: it subscribes and fans the projected view out to
 * listeners, caches the latest view for synchronous reads, and dispatches the
 * granular `connection.*` mutation-cut intents (gated by the intents flag).
 * Best-effort dispatch never throws, even on a rejected ack.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  connectionIntentsEnabled,
  currentConnectionsView,
  ensureConnectionsSubscribed,
  mirrorConnectionIntent,
  onConnectionsView,
  setConnectionIntentsEnabled,
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
  setConnectionIntentsEnabled(null);
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

describe("connectionIntentsEnabled flag", () => {
  it("defaults on and honours the programmatic override", () => {
    expect(connectionIntentsEnabled()).toBe(true);
    setConnectionIntentsEnabled(false);
    expect(connectionIntentsEnabled()).toBe(false);
    setConnectionIntentsEnabled(true);
    expect(connectionIntentsEnabled()).toBe(true);
    setConnectionIntentsEnabled(null);
    expect(connectionIntentsEnabled()).toBe(true);
  });
});

describe("mirrorConnectionIntent (mutation cut)", () => {
  it("dispatches the granular intent when enabled", async () => {
    mirrorConnectionIntent("connection.add", { connection: connection("A/1", "A") });
    await flush();
    expect(transport.dispatched).toHaveLength(1);
    expect(transport.dispatched[0]).toMatchObject({
      kind: "connection.add",
      payload: { connection: { id: "A/1" } },
    });
  });

  it("is a no-op when the mutation cut is disabled", async () => {
    setConnectionIntentsEnabled(false);
    mirrorConnectionIntent("connection.remove", { connectionId: "A/1" });
    await flush();
    expect(transport.dispatched).toHaveLength(0);
  });

  it("never throws even when the ack is rejected", async () => {
    vi.spyOn(transport, "dispatch").mockResolvedValue({
      intentId: "x",
      status: "rejected",
      error: { message: "boom" },
    } as IntentAck);
    expect(() =>
      mirrorConnectionIntent("connection.toggleFolder", { folderId: "A" })
    ).not.toThrow();
    await flush();
  });
});
