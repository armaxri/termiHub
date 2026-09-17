/**
 * Shared projection-bridge version guard (FES-006). Pins the exact older / equal /
 * newer / first semantics every bridge relies on, plus the `bump` test-seed helper
 * and `reset` (which each bridge must call on a subscription drop / transport swap).
 */
import { describe, expect, it } from "vitest";

import { makeVersionGuard, NO_VERSION_APPLIED } from "./bridgeVersionGuard";

describe("makeVersionGuard", () => {
  it("applies the first snapshot at any non-negative version", () => {
    const guard = makeVersionGuard();
    expect(guard.shouldApply(0)).toBe(true);
  });

  it("applies the first snapshot even at a large starting version", () => {
    const guard = makeVersionGuard();
    expect(guard.shouldApply(42)).toBe(true);
    // …and the next newer one still applies.
    expect(guard.shouldApply(43)).toBe(true);
  });

  it("applies a strictly newer version", () => {
    const guard = makeVersionGuard();
    guard.shouldApply(1);
    expect(guard.shouldApply(2)).toBe(true);
  });

  it("applies an equal version (an optimistic re-emit at the same region version)", () => {
    const guard = makeVersionGuard();
    guard.shouldApply(5);
    expect(guard.shouldApply(5)).toBe(true);
  });

  it("drops a strictly older (stale, out-of-order) version", () => {
    const guard = makeVersionGuard();
    guard.shouldApply(5);
    expect(guard.shouldApply(4)).toBe(false);
  });

  it("keeps the high-water mark after dropping a stale version", () => {
    const guard = makeVersionGuard();
    guard.shouldApply(5);
    expect(guard.shouldApply(3)).toBe(false);
    // A stale drop must not lower the water mark: 4 is still stale…
    expect(guard.shouldApply(4)).toBe(false);
    // …and only a version >= 5 applies again.
    expect(guard.shouldApply(5)).toBe(true);
    expect(guard.shouldApply(6)).toBe(true);
  });

  it("advances the high-water mark on every applied version", () => {
    const guard = makeVersionGuard();
    expect(guard.shouldApply(1)).toBe(true);
    expect(guard.shouldApply(2)).toBe(true);
    expect(guard.shouldApply(3)).toBe(true);
    // Anything at or below 3 is now stale.
    expect(guard.shouldApply(3)).toBe(true); // equal still applies
    expect(guard.shouldApply(2)).toBe(false);
  });

  it("reset returns to the baseline so a fresh subscription's first snapshot applies", () => {
    const guard = makeVersionGuard();
    guard.shouldApply(9);
    guard.reset();
    // After reset a lower version (a restarted ProjectionClient) applies again.
    expect(guard.shouldApply(0)).toBe(true);
  });

  it("bump advances the water mark by one (the synchronous test-seed helper)", () => {
    const guard = makeVersionGuard();
    guard.shouldApply(0); // last applied = 0
    guard.bump(); // last applied = 1
    // A real diff re-delivered at version 1 (equal) still applies; 0 is now stale.
    expect(guard.shouldApply(0)).toBe(false);
    expect(guard.shouldApply(1)).toBe(true);
  });

  it("bump from the baseline lands at NO_VERSION_APPLIED + 1", () => {
    const guard = makeVersionGuard();
    expect(NO_VERSION_APPLIED).toBe(-1);
    guard.bump(); // -1 -> 0
    // Version 0 is now equal (applies); a negative version would be stale.
    expect(guard.shouldApply(0)).toBe(true);
  });

  it("guards are independent instances (no shared module state)", () => {
    const a = makeVersionGuard();
    const b = makeVersionGuard();
    a.shouldApply(10);
    // b is untouched by a's high-water mark.
    expect(b.shouldApply(0)).toBe(true);
  });
});
