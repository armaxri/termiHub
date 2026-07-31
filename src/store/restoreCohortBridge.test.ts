/**
 * Unit tests for the restore-cohort bridge flags + region id (#2241).
 *
 * Behavioural coverage (mirror dispatch, projected-settlement rendering, and the
 * local fallback) lives in `appStore.restoreCohortMutationCut.test.ts` and
 * `appStore.restoreCohortRenderCut.test.ts`, which drive the bridge through the
 * real `appStore` actions.
 */

import { describe, it, expect, afterEach } from "vitest";

import {
  restoreCohortRegion,
  restoreIntentsEnabled,
  restoreRenderFromProjectionEnabled,
  setRestoreIntentsEnabled,
  setRestoreRenderFromProjectionEnabled,
} from "./restoreCohortBridge";

interface RestoreFlagWindow {
  __TERMIHUB_RESTORE_INTENTS__?: boolean;
  __TERMIHUB_RESTORE_RENDER__?: boolean;
}

afterEach(() => {
  setRestoreIntentsEnabled(null);
  setRestoreRenderFromProjectionEnabled(null);
  const w = window as unknown as RestoreFlagWindow;
  delete w.__TERMIHUB_RESTORE_INTENTS__;
  delete w.__TERMIHUB_RESTORE_RENDER__;
});

describe("restoreCohortBridge flags", () => {
  it("both flags default on", () => {
    expect(restoreIntentsEnabled()).toBe(true);
    expect(restoreRenderFromProjectionEnabled()).toBe(true);
  });

  it("programmatic overrides win, and null restores the default", () => {
    setRestoreIntentsEnabled(false);
    setRestoreRenderFromProjectionEnabled(false);
    expect(restoreIntentsEnabled()).toBe(false);
    expect(restoreRenderFromProjectionEnabled()).toBe(false);

    setRestoreIntentsEnabled(null);
    setRestoreRenderFromProjectionEnabled(null);
    expect(restoreIntentsEnabled()).toBe(true);
    expect(restoreRenderFromProjectionEnabled()).toBe(true);
  });

  it("a window override flips a flag off (rollback switch)", () => {
    const w = window as unknown as RestoreFlagWindow;
    w.__TERMIHUB_RESTORE_INTENTS__ = false;
    w.__TERMIHUB_RESTORE_RENDER__ = false;
    expect(restoreIntentsEnabled()).toBe(false);
    expect(restoreRenderFromProjectionEnabled()).toBe(false);
  });
});

describe("restoreCohortRegion", () => {
  it("is client-scoped, matching the Rust region id", () => {
    expect(restoreCohortRegion("abc123")).toBe("restore-cohort@abc123");
  });
});
