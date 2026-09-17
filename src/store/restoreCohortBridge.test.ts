/**
 * Unit tests for the restore-cohort bridge region id + default view (#2206).
 *
 * Behavioural coverage (intent dispatch, projected-settlement rendering, and the
 * captured failed-tab set) lives in `appStore.restoreCohortMutationCut.test.ts`,
 * `appStore.restoreCohortRenderCut.test.ts`, `appStore.restoreSummary.test.ts` and
 * `appStore.bulkReconnect.test.ts`, which drive the bridge through the real
 * `appStore` actions and the in-memory region twin.
 */

import { afterEach, describe, it, expect } from "vitest";

import {
  __emitRestoreCohortViewForTest,
  currentRestoreCohortView,
  EMPTY_RESTORE_COHORT_VIEW,
  restoreCohortRegion,
  type RestoreCohortView,
  stopRestoreSubscription,
} from "./restoreCohortBridge";

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
