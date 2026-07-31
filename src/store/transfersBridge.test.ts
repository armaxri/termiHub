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
import type { TransferEntry } from "@/types/transfer";

import {
  currentTransfersView,
  deepEqual,
  ensureTransfersSubscribed,
  onTransfersView,
  seedTransfersRegion,
  setTransferRenderFromProjectionEnabled,
  setTransferTransportForTest,
  stopTransfersSubscription,
  transferRenderFromProjectionEnabled,
  TRANSFERS_REGION,
  transfersViewMirrors,
  type TransfersView,
} from "./transfersBridge";

/** A deterministic queue row, keyed by id. */
function entry(id: string, overrides: Partial<TransferEntry> = {}): TransferEntry {
  return {
    id,
    sessionId: "sess-a",
    direction: "download",
    name: `file-${id}`,
    state: "active",
    transferred: 40,
    totalBytes: 100,
    percent: 40,
    speedBytesPerSec: 2048,
    updatedAt: 0,
    ...overrides,
  };
}

/** A `{ [id]: entry }` map from a list of rows. */
function queueOf(...rows: TransferEntry[]): Record<string, TransferEntry> {
  return Object.fromEntries(rows.map((r) => [r.id, r]));
}

/**
 * An in-memory substrate double: holds one `transfers` view, applies a
 * `transfer.replace` intent by overwriting the view from its payload (keyed to the
 * Rust snapshot shape `queue`/`minimized`), and fans a fresh snapshot to every
 * subscriber — so the seed round-trip and multi-subscriber fan-out are exercised
 * without a backend. `structuredClone` mirrors the JSON round-trip's drop of
 * `undefined`-valued optional keys is emulated via {@link stripUndefined}.
 */
class FakeTransport implements Transport {
  dispatched: Intent[] = [];
  private view: Record<string, unknown> = { queue: {}, minimized: false };
  private version = 0;
  private handlers: FrameHandler[] = [];

  async dispatch(intent: Intent): Promise<IntentAck> {
    this.dispatched.push(intent);
    if (intent.kind === "transfer.replace") {
      const p = intent.payload as Record<string, unknown>;
      // Round-trip through JSON to drop undefined-valued keys, exactly as the real
      // transport + Rust store do.
      this.view = JSON.parse(
        JSON.stringify({ queue: p.queue ?? {}, minimized: p.minimized ?? false })
      );
      this.version += 1;
      this.fan();
      return {
        intentId: intent.intentId,
        status: "accepted",
        produced: [{ region: TRANSFERS_REGION, version: this.version }],
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
    const frame: ProjectionFrame = this.snapshot(TRANSFERS_REGION);
    for (const h of this.handlers) h(frame);
  }
}

let transport: FakeTransport;

beforeEach(() => {
  transport = new FakeTransport();
  setTransferTransportForTest(transport);
});

afterEach(() => {
  stopTransfersSubscription();
  setTransferTransportForTest(null);
  setTransferRenderFromProjectionEnabled(null);
});

describe("transferRenderFromProjectionEnabled flag", () => {
  it("defaults on and honours the programmatic override", () => {
    expect(transferRenderFromProjectionEnabled()).toBe(true);
    setTransferRenderFromProjectionEnabled(false);
    expect(transferRenderFromProjectionEnabled()).toBe(false);
    setTransferRenderFromProjectionEnabled(true);
    expect(transferRenderFromProjectionEnabled()).toBe(true);
    setTransferRenderFromProjectionEnabled(null);
    expect(transferRenderFromProjectionEnabled()).toBe(true);
  });
});

describe("deepEqual", () => {
  it("treats an integer and its float round-trip as equal", () => {
    expect(deepEqual(22, 22.0)).toBe(true);
    expect(deepEqual({ a: [1, 2] }, { a: [1, 2] })).toBe(true);
  });

  it("treats an absent optional key and an explicit undefined as equal (JSON semantics)", () => {
    // `appStore` may hold `path: undefined`; the region drops it on serialization.
    expect(deepEqual({ id: "t1", path: undefined }, { id: "t1" })).toBe(true);
    expect(deepEqual({ id: "t1" }, { id: "t1", attempt: undefined })).toBe(true);
  });

  it("distinguishes differing values, key sets, and null", () => {
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqual(null, {})).toBe(false);
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
  });
});

describe("transfersViewMirrors", () => {
  const queue = queueOf(entry("t1"));

  it("is false for an undefined view", () => {
    expect(transfersViewMirrors(undefined, queue, false)).toBe(false);
  });

  it("is true when the view value-matches the appStore slice", () => {
    const view: TransfersView = { queue: structuredClone(queue), minimized: false };
    expect(transfersViewMirrors(view, queue, false)).toBe(true);
  });

  it("is true across a dropped undefined optional key", () => {
    // appStore row carries `path: undefined`; the projected row omits the key.
    const withUndef = queueOf(entry("t1", { path: undefined }));
    const projected = JSON.parse(JSON.stringify(withUndef)) as Record<string, TransferEntry>;
    expect(transfersViewMirrors({ queue: projected, minimized: false }, withUndef, false)).toBe(
      true
    );
  });

  it("is false when the minimized flag diverges", () => {
    const view: TransfersView = { queue: structuredClone(queue), minimized: true };
    expect(transfersViewMirrors(view, queue, false)).toBe(false);
  });

  it("is false when a row's progress diverges", () => {
    const view: TransfersView = {
      queue: queueOf(entry("t1", { transferred: 99, percent: 99 })),
      minimized: false,
    };
    expect(transfersViewMirrors(view, queue, false)).toBe(false);
  });
});

describe("seedTransfersRegion", () => {
  it("dispatches transfer.replace carrying the whole slice, keyed to the Rust shape", async () => {
    const queue = queueOf(entry("t1"));
    await seedTransfersRegion(queue, true);
    expect(transport.dispatched).toHaveLength(1);
    expect(transport.dispatched[0]).toMatchObject({
      kind: "transfer.replace",
      payload: { queue, minimized: true },
    });
  });

  it("de-dupes an identical slice but re-seeds after a change", async () => {
    const queue = queueOf(entry("t1"));
    await seedTransfersRegion(queue, false);
    await seedTransfersRegion(queue, false);
    expect(transport.dispatched).toHaveLength(1);

    await seedTransfersRegion(queue, true); // minimized flipped
    expect(transport.dispatched).toHaveLength(2);
  });
});

describe("seed round-trip → the region mirrors appStore", () => {
  it("makes the projected view a faithful mirror of the seeded slice", async () => {
    const received: TransfersView[] = [];
    const unsubscribe = onTransfersView((v) => received.push(v));
    await ensureTransfersSubscribed();

    const queue = queueOf(entry("t1"), entry("t2", { state: "queued" }));
    await seedTransfersRegion(queue, false);

    // The region now carries the seeded slice and the gate accepts it.
    expect(transfersViewMirrors(currentTransfersView(), queue, false)).toBe(true);
    expect(received[received.length - 1]).toEqual({ queue, minimized: false });
    unsubscribe();
  });
});
