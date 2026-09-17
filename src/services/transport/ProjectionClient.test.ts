import { applyPatch, compare, type Operation } from "fast-json-patch";
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

// ── Subscribe-race frame buffering (CONC-012) ──────────────────────────────────

/**
 * A transport that reproduces the TauriTransport channel-vs-command race: it
 * wires the frame handler and pushes a diff **before** the `subscribe` promise
 * (carrying the initial snapshot) resolves. Real Tauri IPC has no cross-guarantee
 * that the snapshot Promise settles before the first channel message reaches JS.
 */
class RacingTransport implements Transport {
  resyncCount = 0;

  constructor(
    private readonly baseView: unknown,
    private readonly baseVersion: number,
    private readonly earlyDiff: DiffFrame
  ) {}

  async dispatch(): Promise<IntentAck> {
    throw new Error("dispatch not exercised in these tests");
  }

  async subscribe(region: string, onFrame: FrameHandler): Promise<Subscription> {
    // Deliver a diff on the channel before the snapshot is returned/adopted.
    onFrame(this.earlyDiff);
    const snapshot: SnapshotFrame = {
      region,
      kind: "snapshot",
      version: this.baseVersion,
      view: this.baseView,
    };
    return { snapshot, unsubscribe: () => {} };
  }

  async resync(): Promise<SnapshotFrame | null> {
    this.resyncCount += 1;
    return null;
  }
}

describe("ProjectionClient · subscribe-race buffering (CONC-012)", () => {
  it("buffers a diff that arrives before the snapshot is adopted, then applies it in order", async () => {
    const earlyDiff: DiffFrame = {
      region: "items",
      kind: "diff",
      baseVersion: 0,
      version: 1,
      ops: [{ op: "add", path: "/items/b", value: "streamed" }],
    };
    const transport = new RacingTransport(itemsView({ a: "base" }), 0, earlyDiff);
    const client = new ProjectionClient(transport, "items");
    const states: ProjectionCacheState[] = [];
    client.onChange((s) => states.push(clone(s)));

    await client.start();

    // The pre-snapshot diff was buffered and flushed in order, not treated as a
    // gap: no redundant resync, and the diff landed on the adopted baseline.
    expect(transport.resyncCount).toBe(0);
    expect(client.state.version).toBe(1);
    expect(client.state.view).toEqual(itemsView({ a: "base", b: "streamed" }));
  });

  it("never regresses the version when a later snapshot arrives with an older version", () => {
    const transport = new FakeTransport(itemsView({ a: "base" }), "items");
    const client = new ProjectionClient(transport, "items");

    // Advance the cache to v2 via two diffs.
    return client.start().then(() => {
      transport.publish(itemsView({ a: "base", b: "one" }));
      transport.publish(itemsView({ a: "base", b: "two" }));
      expect(client.state.version).toBe(2);

      // A stale/racing snapshot at an older version must not roll the cache back.
      const stale = client.state.view;
      transport.emit({ region: "items", kind: "snapshot", version: 1, view: itemsView() });
      expect(client.state.version).toBe(2);
      expect(client.state.view).toEqual(stale);
    });
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

// ── Structural-sharing diff apply (PERF-005) ───────────────────────────────────

/**
 * A representative region view carrying the substrate's real shapes: a keyed
 * map (`sessions`, like the sessions/monitors regions), an ordered array
 * (`connections`), and a nested stats cache (`statsCache`, updated frequently).
 */
interface RichView {
  sessions: Record<string, { status: string; bytes: number }>;
  connections: { id: string }[];
  statsCache: Record<string, { cpu: number }>;
}

const richView = (): RichView => ({
  sessions: {
    s1: { status: "connected", bytes: 1 },
    s2: { status: "idle", bytes: 2 },
  },
  connections: [{ id: "c1" }, { id: "c2" }],
  statsCache: { m1: { cpu: 10 } },
});

/**
 * Drives deterministic RFC-6902 diffs (computed with the same `compare` the
 * backend mirrors) into a client and records every emitted view **by
 * reference** — the raw `state.view`, never a clone — so reference-identity and
 * immutability can be asserted.
 */
function makeSharingHarness() {
  const transport = new FakeTransport(richView(), "monitors");
  const client = new ProjectionClient(transport, "monitors");
  const views: unknown[] = [];
  client.onChange((s) => views.push(s.view));

  let serverView: unknown = clone(richView());
  let serverVersion = 0;
  // A reference document maintained via the OLD deep-clone applier path
  // (`mutateDocument=false`) — the observable behaviour the new path must match.
  let refView: unknown = clone(richView());

  /** Apply a mutation on the server, stream its diff, and mirror it on the ref. */
  const step = (mutate: (v: ReturnType<typeof richView>) => void): DiffOp[] => {
    const next = clone(serverView) as ReturnType<typeof richView>;
    mutate(next);
    const ops = compare(serverView as object, next as object) as DiffOp[];
    const baseVersion = serverVersion;
    const version = baseVersion + 1;
    serverView = next;
    serverVersion = version;
    refView = applyPatch(clone(refView), ops as unknown as Operation[], false, false).newDocument;
    transport.emit({ region: "monitors", kind: "diff", baseVersion, version, ops });
    return ops;
  };

  return {
    client,
    views,
    step,
    ref: () => refView,
    latest: () => views[views.length - 1] as Record<string, unknown>,
  };
}

describe("ProjectionClient · structural-sharing diff apply (PERF-005)", () => {
  it("stays byte-for-byte equal to the deep-clone applier across a sequence of diffs", async () => {
    const h = makeSharingHarness();
    await h.client.start();

    h.step((v) => (v.sessions.s1.status = "closing"));
    expect(h.client.state.view).toEqual(h.ref());
    h.step((v) => (v.sessions.s3 = { status: "new", bytes: 0 }));
    expect(h.client.state.view).toEqual(h.ref());
    h.step((v) => delete v.sessions.s2);
    expect(h.client.state.view).toEqual(h.ref());
    h.step((v) => (v.statsCache.m1.cpu = 99));
    expect(h.client.state.view).toEqual(h.ref());
    h.step((v) => v.connections.push({ id: "c3" }));
    expect(h.client.state.view).toEqual(h.ref());
    h.step((v) => v.connections.splice(0, 1));
    expect(h.client.state.view).toEqual(h.ref());

    // Independent cross-check: the emitted view equals the authored server view.
    expect(h.client.state.view).toEqual(h.ref());
  });

  it("never mutates a previously-emitted view when a later diff is applied (immutability invariant)", async () => {
    const h = makeSharingHarness();
    await h.client.start();

    h.step((v) => (v.sessions.s1.status = "connecting"));
    const v1 = h.latest();
    const v1Snapshot = clone(v1); // structural snapshot of v1 BEFORE the next diff

    h.step((v) => (v.sessions.s2.status = "closing"));
    const v2 = h.latest();

    // v1 (and every nested object it holds) is byte-for-byte unchanged: the
    // second diff did not reach into any object a prior emission handed out.
    expect(v1).toEqual(v1Snapshot);
    // A genuinely new top-level document was produced.
    expect(v2).not.toBe(v1);
  });

  it("shares untouched subtrees by reference and only re-identifies the touched path", async () => {
    const h = makeSharingHarness();
    await h.client.start();

    h.step((v) => (v.sessions.s1.status = "connecting"));
    const v1 = h.latest();
    h.step((v) => (v.sessions.s1.status = "connected"));
    const v2 = h.latest();

    // New top-level identity on change.
    expect(v2).not.toBe(v1);
    // Untouched top-level branches are shared by reference (no wasteful clone).
    expect(v2.connections).toBe(v1.connections);
    expect(v2.statsCache).toBe(v1.statsCache);
    // The touched container gets a fresh reference…
    expect(v2.sessions).not.toBe(v1.sessions);
    // …but an untouched sibling entry inside it is still shared…
    const s1 = (v: Record<string, unknown>) => (v.sessions as Record<string, unknown>).s2;
    expect(s1(v2)).toBe(s1(v1));
    // …while only the touched entry is re-identified.
    const touched = (v: Record<string, unknown>) => (v.sessions as Record<string, unknown>).s1;
    expect(touched(v2)).not.toBe(touched(v1));
  });

  it("shares references correctly for add and remove ops too", async () => {
    const h = makeSharingHarness();
    await h.client.start();

    // add a new session entry
    h.step((v) => (v.sessions.s3 = { status: "new", bytes: 0 }));
    const v1 = h.latest();
    // remove a connection (array op)
    h.step((v) => v.connections.splice(0, 1));
    const v2 = h.latest();

    expect(h.client.state.view).toEqual(h.ref());
    // The array-op diff left the untouched `sessions`/`statsCache` branches shared.
    expect(v2.sessions).toBe(v1.sessions);
    expect(v2.statsCache).toBe(v1.statsCache);
    // …and re-identified only the `connections` array it changed.
    expect(v2.connections).not.toBe(v1.connections);
  });
});
