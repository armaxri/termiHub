import { compare } from "fast-json-patch";
import { beforeEach, describe, expect, it } from "vitest";

import { ProjectionClient, type ProjectionCacheState } from "./ProjectionClient";
import type { FrameHandler, Subscription, Transport } from "./Transport";
import type { DiffFrame, DiffOp, IntentAck, ProjectionFrame, SnapshotFrame } from "./types";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/**
 * In-memory transport backed by a single-region "server" that mirrors the Rust
 * `Projector`: subscribe returns a snapshot, `publish` computes a diff and
 * streams it, and `resync` returns the current snapshot (or `null` when the
 * caller is already current). Frame drops and raw frame injection are exposed
 * so tests can force gaps and exercise the semantic-op path.
 */
class FakeTransport implements Transport {
  version = 0;
  view: unknown;
  resyncHaves: Array<number | undefined> = [];
  dropNext = 0;
  private handler?: FrameHandler;

  constructor(
    initial: unknown,
    private readonly region = "tunnels"
  ) {
    this.view = initial;
  }

  async dispatch(): Promise<IntentAck> {
    throw new Error("dispatch not exercised in these tests");
  }

  async subscribe(region: string, onFrame: FrameHandler): Promise<Subscription> {
    this.handler = onFrame;
    return {
      snapshot: this.snapshot(region),
      unsubscribe: () => {
        this.handler = undefined;
      },
    };
  }

  async resync(region: string, have?: number): Promise<SnapshotFrame | null> {
    this.resyncHaves.push(have);
    if (have === this.version) return null;
    return this.snapshot(region);
  }

  /** Mutate authoritative state and stream one diff (unless dropped). */
  publish(newView: unknown): void {
    const ops = compare(this.view as object, newView as object) as DiffOp[];
    if (ops.length === 0) return;
    const baseVersion = this.version;
    const version = baseVersion + 1;
    const frame: DiffFrame = { region: this.region, kind: "diff", baseVersion, version, ops };
    this.view = newView;
    this.version = version;
    if (this.dropNext > 0) {
      this.dropNext -= 1;
      return; // simulate a dropped frame
    }
    this.handler?.(frame);
  }

  /** Push an arbitrary frame to the subscriber (raw injection). */
  emit(frame: ProjectionFrame): void {
    this.handler?.(frame);
  }

  private snapshot(region: string): SnapshotFrame {
    return { region, kind: "snapshot", version: this.version, view: clone(this.view) };
  }
}

const tunnelsView = () => ({
  tunnels: [
    { id: "t1", status: "connected" },
    { id: "t2", status: "stopped" },
  ],
});

describe("ProjectionClient", () => {
  let transport: FakeTransport;
  let client: ProjectionClient;
  let states: ProjectionCacheState[];

  beforeEach(async () => {
    transport = new FakeTransport(tunnelsView());
    client = new ProjectionClient(transport, "tunnels");
    states = [];
    client.onChange((s) => states.push(clone(s)));
    await client.start();
  });

  it("adopts the snapshot as its baseline on subscribe", () => {
    expect(client.state.version).toBe(0);
    expect(client.state.view).toEqual(tunnelsView());
    expect(states).toHaveLength(1);
  });

  it("applies an ordered diff and advances the version by one", () => {
    const next = clone(tunnelsView());
    next.tunnels[1].status = "connecting";
    transport.publish(next);

    expect(client.state.version).toBe(1);
    expect(client.state.view).toEqual(next);
    expect(states[states.length - 1]).toEqual({ version: 1, view: next });
  });

  it("stays in step across several ordered diffs", () => {
    const a = clone(tunnelsView());
    a.tunnels[1].status = "connecting";
    transport.publish(a);
    const b = clone(a);
    b.tunnels[1].status = "connected";
    transport.publish(b);
    const c = clone(b);
    c.tunnels[0].status = "stopped";
    transport.publish(c);

    expect(client.state.version).toBe(3);
    expect(client.state.view).toEqual(transport.view);
  });

  it("detects a gap from a dropped frame and re-baselines via resync", async () => {
    // Drop the next emitted frame: backend advances to v1 but the client never
    // sees it, so it stays at v0.
    transport.dropNext = 1;
    const dropped = clone(tunnelsView());
    dropped.tunnels[1].status = "connecting";
    transport.publish(dropped);
    expect(client.state.version).toBe(0);

    // The following diff has baseVersion 1, which no longer fits the client's
    // v0 — a gap. The client discards it and resyncs.
    const next = clone(dropped);
    next.tunnels[0].status = "stopped";
    transport.publish(next);
    await Promise.resolve(); // let the async resync settle

    expect(transport.resyncHaves).toContain(0);
    expect(client.state.version).toBe(transport.version);
    expect(client.state.view).toEqual(transport.view);
  });

  it("resyncs instead of applying an un-interpretable semantic op", async () => {
    transport.emit({
      region: "tunnels",
      kind: "diff",
      baseVersion: 0,
      version: 1,
      ops: [{ op: "semantic", name: "tunnelStatusChanged", data: { id: "t2" } }],
    });
    await Promise.resolve();

    expect(transport.resyncHaves).toContain(0);
    // Backend was still at v0, so resync returns null and the cache is unchanged.
    expect(client.state.version).toBe(0);
    expect(client.state.view).toEqual(tunnelsView());
  });

  it("resync is a no-op when the cache is already current", async () => {
    await client.resync();
    expect(transport.resyncHaves).toEqual([0]);
    expect(client.state.version).toBe(0);
    expect(states).toHaveLength(1); // no extra change emitted
  });

  it("stops applying frames after stop()", () => {
    client.stop();
    const next = clone(tunnelsView());
    next.tunnels[1].status = "connecting";
    transport.publish(next);
    expect(client.state.version).toBe(0);
    expect(states).toHaveLength(1);
  });
});
