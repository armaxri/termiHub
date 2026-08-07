/**
 * Unit tests for the restore-cohort bridge region id + default view (#2206).
 *
 * Behavioural coverage (intent dispatch, projected-settlement rendering, and the
 * captured failed-tab set) lives in `appStore.restoreCohortMutationCut.test.ts`,
 * `appStore.restoreCohortRenderCut.test.ts`, `appStore.restoreSummary.test.ts` and
 * `appStore.bulkReconnect.test.ts`, which drive the bridge through the real
 * `appStore` actions and the in-memory region twin.
 */

import { describe, it, expect } from "vitest";

import {
  currentRestoreCohortView,
  EMPTY_RESTORE_COHORT_VIEW,
  restoreCohortRegion,
} from "./restoreCohortBridge";

describe("restoreCohortRegion", () => {
  it("is client-scoped, matching the Rust region id", () => {
    expect(restoreCohortRegion("abc123")).toBe("restore-cohort@abc123");
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
