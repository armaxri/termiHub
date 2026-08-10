import { compare } from "fast-json-patch";
import { beforeEach, describe, expect, it } from "vitest";

import { ProjectionClient, type ProjectionCacheState } from "./ProjectionClient";
import type { FrameHandler, Subscription, Transport } from "./Transport";
import type { DiffFrame, DiffOp, Intent, IntentAck, ProjectionFrame, SnapshotFrame } from "./types";

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

  /** Intents seen by {@link dispatch}, newest last. */
  dispatched: Intent[] = [];
  /** Optional stub for {@link dispatch}; unset ⇒ dispatch is not exercised. */
  dispatchHandler?: (intent: Intent) => IntentAck | Promise<IntentAck>;

  async dispatch(intent: Intent): Promise<IntentAck> {
    this.dispatched.push(intent);
    if (this.dispatchHandler) return this.dispatchHandler(intent);
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

// ── Optimistic client-side folding (#2533) ─────────────────────────────────────

/** A tiny region view used for the overlay tests: `{ items: { <id>: value } }`. */
const itemsView = (items: Record<string, string> = {}) => ({ items });

/** A fold that optimistically sets `items[id] = value`, immutably. */
const setItem =
  (id: string, value: string) =>
  (view: unknown): unknown => {
    const v = (view ?? { items: {} }) as { items: Record<string, string> };
    return { ...v, items: { ...v.items, [id]: value } };
  };

const intentFor = (id: string): Intent => ({
  intentId: `intent-${id}`,
  kind: "test.set",
  payload: { id },
  clientId: "client-test",
});

const accepted = (region: string, version: number): IntentAck => ({
  intentId: "ignored",
  status: "accepted",
  produced: [{ region, version }],
});

describe("ProjectionClient · optimistic folding (#2533)", () => {
  let transport: FakeTransport;
  let client: ProjectionClient;
  let states: ProjectionCacheState[];

  beforeEach(async () => {
    transport = new FakeTransport(itemsView({ a: "base" }), "items");
    client = new ProjectionClient(transport, "items");
    states = [];
    client.onChange((s) => states.push(clone(s)));
    await client.start();
  });

  it("applies the optimistic fold synchronously, before the ack resolves", () => {
    transport.dispatchHandler = () => accepted("items", 1);
    // Do NOT await: the overlay must be visible the moment dispatch returns.
    void client.dispatchOptimistic(intentFor("b"), setItem("b", "optimistic"));

    expect(client.state.view).toEqual(itemsView({ a: "base", b: "optimistic" }));
    // The version is untouched — the overlay is not an authoritative advance.
    expect(client.state.version).toBe(0);
    expect(transport.dispatched).toHaveLength(1);
  });

  it("keeps the overlay until the confirming version, then the authoritative diff supersedes it", async () => {
    transport.dispatchHandler = () => accepted("items", 1);
    const ack = await client.dispatchOptimistic(intentFor("b"), setItem("b", "optimistic"));
    expect(ack.status).toBe("accepted");

    // Backend has not reached v1 yet ⇒ the overlay still stands.
    expect(client.state.view).toEqual(itemsView({ a: "base", b: "optimistic" }));

    // The authoritative diff lands at v1 — with the backend's OWN value, which
    // may differ from the optimistic guess. It supersedes the overlay exactly
    // (no double-apply, no leftover optimistic value).
    transport.publish(itemsView({ a: "base", b: "authoritative" }));

    expect(client.state.version).toBe(1);
    expect(client.state.view).toEqual(itemsView({ a: "base", b: "authoritative" }));
  });

  it("rolls the overlay back cleanly when the intent is rejected (divergence)", async () => {
    transport.dispatchHandler = () => ({
      intentId: "ignored",
      status: "rejected",
      error: { code: "denied", message: "nope" },
    });
    const p = client.dispatchOptimistic(intentFor("b"), setItem("b", "optimistic"));
    // Synchronously overlaid…
    expect(client.state.view).toEqual(itemsView({ a: "base", b: "optimistic" }));

    const ack = await p;
    expect(ack.status).toBe("rejected");
    // …then rolled back to the authoritative baseline once the rejection lands.
    expect(client.state.view).toEqual(itemsView({ a: "base" }));
    expect(client.state.version).toBe(0);
  });

  it("rolls back when the intent produced no change on this region (no-op divergence)", async () => {
    // Accepted, but the change (if any) lands on a different region — nothing
    // authoritative will ever confirm the overlay here.
    transport.dispatchHandler = () => accepted("other-region", 7);
    const ack = await client.dispatchOptimistic(intentFor("b"), setItem("b", "optimistic"));

    expect(ack.status).toBe("accepted");
    expect(client.state.view).toEqual(itemsView({ a: "base" }));
  });

  it("reconciles when the authoritative diff races AHEAD of the ack", async () => {
    // Hold the ack open so the diff can land first.
    let resolveAck!: (ack: IntentAck) => void;
    transport.dispatchHandler = () => new Promise<IntentAck>((r) => (resolveAck = r));

    const p = client.dispatchOptimistic(intentFor("b"), setItem("b", "optimistic"));
    expect(client.state.view).toEqual(itemsView({ a: "base", b: "optimistic" }));

    // The confirming diff arrives before the ack: the overlay is still layered
    // over the new baseline (transient) since its confirm version is unknown.
    transport.publish(itemsView({ a: "base", b: "authoritative" }));
    expect(client.state.version).toBe(1);
    expect(client.state.view).toEqual(itemsView({ a: "base", b: "optimistic" }));

    // Ack resolves with the produced version the diff already reached ⇒ prune.
    resolveAck(accepted("items", 1));
    await p;
    expect(client.state.view).toEqual(itemsView({ a: "base", b: "authoritative" }));
  });

  it("rolls back when the dispatch transport throws, and rethrows", async () => {
    transport.dispatchHandler = () => {
      throw new Error("transport down");
    };
    const p = client.dispatchOptimistic(intentFor("b"), setItem("b", "optimistic"));
    // Overlay is applied synchronously even though the dispatch will fail.
    expect(client.state.view).toEqual(itemsView({ a: "base", b: "optimistic" }));

    await expect(p).rejects.toThrow("transport down");
    // Rolled back so the caller's fallback path sees an un-diverged view.
    expect(client.state.view).toEqual(itemsView({ a: "base" }));
  });

  it("keeps independent overlays; confirming one leaves the other standing", async () => {
    transport.dispatchHandler = (intent) =>
      // b confirms at v1, c at v2.
      accepted("items", intent.intentId === "intent-b" ? 1 : 2);

    await client.dispatchOptimistic(intentFor("b"), setItem("b", "opt-b"));
    await client.dispatchOptimistic(intentFor("c"), setItem("c", "opt-c"));
    expect(client.state.view).toEqual(itemsView({ a: "base", b: "opt-b", c: "opt-c" }));

    // Backend reaches v1: b's fold is pruned; c's (confirm v2) still stands.
    transport.publish(itemsView({ a: "base", b: "srv-b" }));
    expect(client.state.view).toEqual(itemsView({ a: "base", b: "srv-b", c: "opt-c" }));

    // Backend reaches v2: c's fold is pruned too.
    transport.publish(itemsView({ a: "base", b: "srv-b", c: "srv-c" }));
    expect(client.state.view).toEqual(itemsView({ a: "base", b: "srv-b", c: "srv-c" }));
  });

  it("leaves the effective view reference-identical to the baseline with no overlay", () => {
    // Regions that never dispatch optimistically are unaffected: the emitted
    // view IS the authoritative baseline object (the 8 inverted domains).
    expect(client.state.view).toBe((client as unknown as { baseView: unknown }).baseView);
  });
});
