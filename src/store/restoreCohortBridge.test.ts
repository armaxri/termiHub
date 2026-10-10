/**
 * Unit tests for the restore-cohort bridge region id + default view (#2206).
 *
 * Behavioural coverage (intent dispatch, projected-settlement rendering, and the
 * captured failed-tab set) lives in `appStore.restoreCohortMutationCut.test.ts`,
 * `appStore.restoreCohortRenderCut.test.ts`, `appStore.restoreSummary.test.ts` and
 * `appStore.bulkReconnect.test.ts`, which drive the bridge through the real
 * `appStore` actions and the in-memory region twin.
 */

import { afterEach, beforeEach, describe, it, expect } from "vitest";

import {
  __emitRestoreCohortViewForTest,
  currentRestoreCohortView,
  EMPTY_RESTORE_COHORT_VIEW,
  mirrorRestoreBegin,
  onRestoreCohortSettled,
  restoreCohortRegion,
  type RestoreCohortView,
  setRestoreTransportForTest,
  stopRestoreSubscription,
} from "./restoreCohortBridge";
import type {
  FrameHandler,
  Intent,
  IntentAck,
  SnapshotFrame,
  Subscription,
  Transport,
} from "@/services/transport";

describe("restoreCohortRegion", () => {
  it("is client-scoped, matching the Rust region id", () => {
    expect(restoreCohortRegion("abc123")).toBe("restore-cohort@abc123");
  });
});

describe("version guard (FES-006)", () => {
  afterEach(() => {
    // Reset the module-level cached view + version guard so the emit tests below do
    // not leak state into other cases.
    stopRestoreSubscription();
  });

  it("applies the first snapshot, then a newer one, and drops a stale older one", () => {
    const withFailed = (ids: string[]): RestoreCohortView => ({
      cohort: null,
      failedTabIds: ids,
      settlement: null,
    });

    __emitRestoreCohortViewForTest(withFailed(["a"]), 1);
    expect(currentRestoreCohortView().failedTabIds).toEqual(["a"]);

    __emitRestoreCohortViewForTest(withFailed(["a", "b"]), 2);
    expect(currentRestoreCohortView().failedTabIds).toEqual(["a", "b"]);

    // A strictly older version is dropped — the newer view stays.
    __emitRestoreCohortViewForTest(withFailed(["STALE"]), 1);
    expect(currentRestoreCohortView().failedTabIds).toEqual(["a", "b"]);
  });
});

describe("currentRestoreCohortView", () => {
  it("is the empty view before any projection diff", () => {
    expect(currentRestoreCohortView()).toEqual(EMPTY_RESTORE_COHORT_VIEW);
    expect(currentRestoreCohortView().cohort).toBeNull();
    expect(currentRestoreCohortView().failedTabIds).toEqual([]);
    expect(currentRestoreCohortView().settlement).toBeNull();
  });
});

// ── Cohort-settled signal (#4387) ─────────────────────────────────────────────

/** A transport whose begin acks the test resolves by hand, so the settling diff
 * can be delivered before or after the ack. */
class ManualAckTransport implements Transport {
  dispatched: Intent[] = [];
  private acks: Array<(ack: IntentAck) => void> = [];

  dispatch(intent: Intent): Promise<IntentAck> {
    this.dispatched.push(intent);
    return new Promise((resolve) => this.acks.push(resolve));
  }

  /** Resolve the `i`-th dispatch with an accepted ack at `version`. */
  ack(i: number, version: number | null, status: "accepted" | "rejected" = "accepted"): void {
    const intent = this.dispatched[i];
    this.acks[i]({
      intentId: intent.intentId,
      status,
      produced: version === null ? [] : [{ region: restoreCohortRegion(intent.clientId), version }],
    });
  }

  async subscribe(region: string, _onFrame: FrameHandler): Promise<Subscription> {
    return {
      snapshot: { kind: "snapshot", region, version: 0, view: EMPTY_RESTORE_COHORT_VIEW },
      unsubscribe: () => undefined,
    };
  }

  async resync(): Promise<SnapshotFrame | null> {
    return null;
  }
}

const settledView = (seq: number): RestoreCohortView => ({
  cohort: null,
  failedTabIds: [],
  settlement: { seq, total: 1, restored: 1, failed: 0, retryTabIds: [] },
});
const inFlightView: RestoreCohortView = {
  cohort: { pending: ["t1"], total: 1, failed: 0, failedTabIds: [] },
  failedTabIds: [],
  settlement: null,
};

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("onRestoreCohortSettled (#4387)", () => {
  let t: ManualAckTransport;
  let fired: number;
  let unsubscribe: () => void;

  beforeEach(() => {
    t = new ManualAckTransport();
    setRestoreTransportForTest(t);
    fired = 0;
    unsubscribe = onRestoreCohortSettled(() => {
      fired += 1;
    });
  });

  afterEach(() => {
    unsubscribe();
    setRestoreTransportForTest(null);
  });

  it("fires once the begun cohort's settling view lands after its ack", async () => {
    mirrorRestoreBegin({ pendingTabIds: ["t1"], preFailedCount: 0 });
    t.ack(0, 5);
    await flushMicrotasks();
    expect(fired).toBe(0);

    __emitRestoreCohortViewForTest(inFlightView, 5);
    expect(fired).toBe(0);

    __emitRestoreCohortViewForTest(settledView(1), 6);
    expect(fired).toBe(1);
  });

  it("fires when the settling view arrives before the begin's ack resolves", async () => {
    mirrorRestoreBegin({ pendingTabIds: ["t1"], preFailedCount: 0 });
    // An all-pre-failed / instantly-settling cohort: the view at the begin's own
    // version is already settled, and the diff races ahead of the ack.
    __emitRestoreCohortViewForTest(settledView(1), 5);
    expect(fired).toBe(0);

    t.ack(0, 5);
    await flushMicrotasks();
    expect(fired).toBe(1);
  });

  it("ignores an older cohort's settlement that is still in flight", async () => {
    mirrorRestoreBegin({ pendingTabIds: ["t1"], preFailedCount: 0 });
    t.ack(0, 7);
    await flushMicrotasks();

    // A settlement folded before the begin (version 6 < 7) belongs to a
    // superseded cohort and must not lower the guard for the new one.
    __emitRestoreCohortViewForTest(settledView(1), 6);
    expect(fired).toBe(0);

    __emitRestoreCohortViewForTest(settledView(2), 8);
    expect(fired).toBe(1);
  });

  it("only awaits the most recent begin", async () => {
    mirrorRestoreBegin({ pendingTabIds: ["a"], preFailedCount: 0 });
    mirrorRestoreBegin({ pendingTabIds: ["b"], preFailedCount: 0 });
    // The first (superseded) begin's ack is ignored.
    t.ack(0, 3);
    await flushMicrotasks();
    __emitRestoreCohortViewForTest(settledView(1), 3);
    expect(fired).toBe(0);

    t.ack(1, 4);
    await flushMicrotasks();
    __emitRestoreCohortViewForTest(settledView(2), 5);
    expect(fired).toBe(1);
  });

  it("does not fire for a rejected begin (the guard's safety timeout covers it)", async () => {
    mirrorRestoreBegin({ pendingTabIds: ["t1"], preFailedCount: 0 });
    t.ack(0, null, "rejected");
    await flushMicrotasks();
    __emitRestoreCohortViewForTest(settledView(1), 9);
    expect(fired).toBe(0);
  });

  it("fires immediately for an empty cohort, which the region never settles", () => {
    mirrorRestoreBegin({ pendingTabIds: [], preFailedCount: 0 });
    expect(fired).toBe(1);
  });

  it("fires exactly once per begin", async () => {
    mirrorRestoreBegin({ pendingTabIds: ["t1"], preFailedCount: 0 });
    t.ack(0, 2);
    await flushMicrotasks();
    __emitRestoreCohortViewForTest(settledView(1), 2);
    __emitRestoreCohortViewForTest(settledView(1), 3);
    expect(fired).toBe(1);
  });
});
