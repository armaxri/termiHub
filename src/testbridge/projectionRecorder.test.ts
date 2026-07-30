import { describe, expect, it } from "vitest";

import type {
  DiffFrame,
  DiffOp,
  FrameHandler,
  Intent,
  IntentAck,
  SnapshotFrame,
  Subscription,
  Transport,
} from "@/services/transport";

import { ProjectionRecorder } from "./projectionRecorder";

const REGION = "diag.counter";

/** Let a fire-and-forget `ProjectionClient.resync()` settle before asserting. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A tiny in-memory stand-in for the backend projector, mirroring the substrate's
 * semantics: a versioned `{ count }` view, multi-subscriber diff fan-out, and a
 * `resync` that re-baselines a stale caller. Only the `count.increment` intent is
 * handled — enough to exercise the recorder's record / drop / gap-resync paths
 * without the real app.
 */
class FakeBackend implements Transport {
  private version = 0;
  private view: { count: number } = { count: 0 };
  private readonly subscribers = new Map<number, FrameHandler>();
  private nextSub = 0;

  private snapshot(): SnapshotFrame {
    return { region: REGION, kind: "snapshot", version: this.version, view: { ...this.view } };
  }

  async subscribe(region: string, onFrame: FrameHandler): Promise<Subscription> {
    const id = this.nextSub++;
    this.subscribers.set(id, onFrame);
    return {
      snapshot: this.snapshot(),
      unsubscribe: () => {
        this.subscribers.delete(id);
      },
    };
  }

  async dispatch(intent: Intent): Promise<IntentAck> {
    const by = (intent.payload as { by?: number } | undefined)?.by ?? 1;
    const baseVersion = this.version;
    this.view = { count: this.view.count + by };
    this.version += 1;
    const ops: DiffOp[] = [{ op: "replace", path: "/count", value: this.view.count }];
    const frame: DiffFrame = {
      region: REGION,
      kind: "diff",
      baseVersion,
      version: this.version,
      ops,
    };
    for (const handler of this.subscribers.values()) handler(frame);
    return {
      intentId: intent.intentId,
      status: "accepted",
      produced: [{ region: REGION, version: this.version }],
    };
  }

  async resync(region: string, have?: number): Promise<SnapshotFrame | null> {
    if (have === this.version) return null;
    return this.snapshot();
  }
}

describe("ProjectionRecorder", () => {
  it("adopts the snapshot on attach", async () => {
    const recorder = new ProjectionRecorder(new FakeBackend());
    const sub = await recorder.subscribe(REGION);

    expect(sub.snapshot).toEqual({ region: REGION, kind: "snapshot", version: 0, view: { count: 0 } });
    expect(sub.frames).toEqual([]);
    expect(sub.cache).toEqual({ version: 0, view: { count: 0 } });
  });

  it("records the diff a dispatched intent produces and applies it to the cache", async () => {
    const recorder = new ProjectionRecorder(new FakeBackend());
    const sub = await recorder.subscribe(REGION);

    const ack = await recorder.dispatch({ kind: "count.increment", payload: { by: 2 } });
    expect(ack.status).toBe("accepted");

    const state = recorder.state(sub.subscriptionId);
    expect(state.frames).toHaveLength(1);
    const diff = state.frames[0] as DiffFrame;
    expect(diff.kind).toBe("diff");
    expect(diff.baseVersion).toBe(0);
    expect(diff.version).toBe(1);
    expect(diff.ops).toEqual([{ op: "replace", path: "/count", value: 2 }]);
    expect(state.cache).toEqual({ version: 1, view: { count: 2 } });
  });

  it("fans one diff out to every subscriber with an identical version sequence", async () => {
    const recorder = new ProjectionRecorder(new FakeBackend());
    const a = await recorder.subscribe(REGION);
    const b = await recorder.subscribe(REGION);

    await recorder.dispatch({ kind: "count.increment", payload: { by: 1 } });
    await recorder.dispatch({ kind: "count.increment", payload: { by: 1 } });

    const stateA = recorder.state(a.subscriptionId);
    const stateB = recorder.state(b.subscriptionId);
    const versions = (s: typeof stateA) => s.frames.map((f) => f.version);
    expect(versions(stateA)).toEqual([1, 2]);
    expect(versions(stateB)).toEqual([1, 2]);
    expect(stateA.cache).toEqual(stateB.cache);
    expect(stateA.cache).toEqual({ version: 2, view: { count: 2 } });
  });

  it("re-baselines via resync after a forced gap (a dropped diff)", async () => {
    const recorder = new ProjectionRecorder(new FakeBackend());
    const sub = await recorder.subscribe(REGION);

    await recorder.dispatch({ kind: "count.increment", payload: { by: 1 } }); // v1, delivered
    recorder.dropNext(sub.subscriptionId, 1);
    await recorder.dispatch({ kind: "count.increment", payload: { by: 1 } }); // v2, dropped
    await recorder.dispatch({ kind: "count.increment", payload: { by: 1 } }); // v3 → gap → resync
    await flush();

    const state = recorder.state(sub.subscriptionId);
    // All three diffs were produced and recorded, including the dropped one.
    expect(state.frames.map((f) => f.version)).toEqual([1, 2, 3]);
    // The client never applied the stale v2/v3 diffs out of order; it re-baselined
    // from the backend snapshot at the current version.
    expect(state.cache).toEqual({ version: 3, view: { count: 3 } });
    expect(state.dropRemaining).toBe(0);
  });

  it("resyncs explicitly on request", async () => {
    const backend = new FakeBackend();
    const recorder = new ProjectionRecorder(backend);
    const sub = await recorder.subscribe(REGION);

    recorder.dropNext(sub.subscriptionId, 5); // swallow every delivered diff
    await recorder.dispatch({ kind: "count.increment", payload: { by: 4 } });
    // The cache is stale (the diff was dropped); an explicit resync re-baselines.
    expect(recorder.state(sub.subscriptionId).cache.version).toBe(0);

    const state = await recorder.resync(sub.subscriptionId);
    expect(state.cache).toEqual({ version: 1, view: { count: 4 } });
  });

  it("throws for an unknown subscription id", () => {
    const recorder = new ProjectionRecorder(new FakeBackend());
    expect(() => recorder.state("nope")).toThrow(/no projection subscription/);
  });
});
