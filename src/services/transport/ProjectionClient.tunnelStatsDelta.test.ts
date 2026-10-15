/**
 * The `tunnels` region's stats-only delta, as the frontend sees it (#4574).
 *
 * The backend's 1 Hz live-stats tick now publishes a delta whose ops touch only
 * `/states/<id>/stats/*` instead of a full region rebuild. The frontend keeps
 * rendering identically only if applying that delta yields exactly the view a
 * full publish would have produced. These tests feed the real
 * {@link ProjectionClient} the delta frames the Rust side emits and pin:
 * parity with the full view, untouched config list identity, and the gap →
 * resync path when a delta is missed.
 */
import { describe, expect, it } from "vitest";

import { ProjectionClient } from "./ProjectionClient";
import type { FrameHandler, Subscription, Transport } from "./Transport";
import type { DiffFrame, DiffOp, IntentAck, SnapshotFrame } from "./types";

interface Stats {
  bytesSent: number;
  bytesReceived: number;
  activeConnections: number;
  totalConnections: number;
}

const ZERO: Stats = { bytesSent: 0, bytesReceived: 0, activeConnections: 0, totalConnections: 0 };

/** The full `tunnels` view (twin of Rust `tunnel_view_from`) for t1's stats. */
function fullView(t1: Stats): unknown {
  return {
    tunnels: [
      { id: "t1", name: "db" },
      { id: "t2", name: "socks" },
    ],
    states: {
      t1: { tunnelId: "t1", status: "connected", stats: t1 },
      t2: { tunnelId: "t2", status: "disconnected", stats: ZERO },
    },
  };
}

/** The ops the Rust stats delta emits for t1 going `from` → `to`. */
function statsOps(from: Stats, to: Stats): DiffOp[] {
  return (Object.keys(to) as Array<keyof Stats>)
    .sort()
    .filter((key) => from[key] !== to[key])
    .map((key) => ({ op: "replace", path: `/states/t1/stats/${key}`, value: to[key] }));
}

/** A one-region transport whose frames and resync answers the test controls. */
class ScriptedTransport implements Transport {
  handler?: FrameHandler;
  resyncHaves: Array<number | undefined> = [];

  constructor(
    public version: number,
    public view: unknown
  ) {}

  async dispatch(): Promise<IntentAck> {
    throw new Error("dispatch not exercised");
  }

  async subscribe(region: string, onFrame: FrameHandler): Promise<Subscription> {
    this.handler = onFrame;
    return { snapshot: this.snapshot(region), unsubscribe: () => undefined };
  }

  async resync(region: string, have?: number): Promise<SnapshotFrame | null> {
    this.resyncHaves.push(have);
    return have === this.version ? null : this.snapshot(region);
  }

  /** Advance the backend by one stats delta; deliver it unless `drop`. */
  tick(from: Stats, to: Stats, drop = false): void {
    const frame: DiffFrame = {
      region: "tunnels",
      kind: "diff",
      baseVersion: this.version,
      version: this.version + 1,
      ops: statsOps(from, to),
    };
    this.version += 1;
    this.view = fullView(to);
    if (!drop) this.handler?.(frame);
  }

  private snapshot(region: string): SnapshotFrame {
    return {
      region,
      kind: "snapshot",
      version: this.version,
      view: JSON.parse(JSON.stringify(this.view)) as unknown,
    };
  }
}

async function started(): Promise<{ transport: ScriptedTransport; client: ProjectionClient }> {
  const transport = new ScriptedTransport(0, fullView(ZERO));
  const client = new ProjectionClient(transport, "tunnels");
  await client.start();
  return { transport, client };
}

describe("ProjectionClient · tunnels stats-only delta (#4574)", () => {
  it("applying stats deltas yields exactly the full-publish view", async () => {
    const { transport, client } = await started();
    const ticks: Stats[] = [
      { bytesSent: 100, bytesReceived: 50, activeConnections: 1, totalConnections: 1 },
      { bytesSent: 400, bytesReceived: 90, activeConnections: 2, totalConnections: 3 },
      { bytesSent: 400, bytesReceived: 90, activeConnections: 0, totalConnections: 3 },
    ];

    let prev = ZERO;
    for (const next of ticks) {
      transport.tick(prev, next);
      expect(client.state.version).toBe(transport.version);
      expect(client.state.view).toEqual(fullView(next));
      prev = next;
    }
  });

  it("leaves the config list and untouched states reference-identical", async () => {
    const { transport, client } = await started();
    const before = client.state.view as {
      tunnels: unknown;
      states: Record<string, unknown>;
    };

    transport.tick(ZERO, { ...ZERO, bytesSent: 10 });

    const after = client.state.view as typeof before;
    expect(after.tunnels).toBe(before.tunnels);
    expect(after.states.t2).toBe(before.states.t2);
    expect(after.states.t1).not.toBe(before.states.t1);
  });

  it("detects a missed delta and resyncs to the full view", async () => {
    const { transport, client } = await started();
    const s1: Stats = { ...ZERO, bytesSent: 1 };
    const s2: Stats = { ...ZERO, bytesSent: 2, totalConnections: 1 };

    transport.tick(ZERO, s1, true); // dropped: the client stays at v0
    expect(client.state.version).toBe(0);

    transport.tick(s1, s2); // baseVersion 1 does not fit v0 → gap → resync
    await Promise.resolve();
    await Promise.resolve();

    expect(transport.resyncHaves).toContain(0);
    expect(client.state.version).toBe(2);
    expect(client.state.view).toEqual(fullView(s2));
  });
});
