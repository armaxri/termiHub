import { describe, it, expect } from "vitest";
import { pushBounded } from "./ringBuffer";

describe("pushBounded", () => {
  it("appends a value while under capacity", () => {
    expect(pushBounded([1, 2], 3, 5)).toEqual([1, 2, 3]);
  });

  it("evicts the oldest sample once at capacity", () => {
    expect(pushBounded([1, 2, 3], 4, 3)).toEqual([2, 3, 4]);
  });

  it("keeps exactly `capacity` samples across a long stream", () => {
    let history: number[] = [];
    for (let i = 1; i <= 200; i++) history = pushBounded(history, i, 60);
    expect(history).toHaveLength(60);
    // Only the most recent 60 values survive (141..200).
    expect(history[0]).toBe(141);
    expect(history[history.length - 1]).toBe(200);
  });

  it("does not mutate the input array", () => {
    const input = [1, 2, 3];
    const out = pushBounded(input, 4, 3);
    expect(input).toEqual([1, 2, 3]);
    expect(out).not.toBe(input);
  });

  it("returns an empty array for a non-positive capacity", () => {
    expect(pushBounded([1, 2, 3], 4, 0)).toEqual([]);
    expect(pushBounded([1, 2, 3], 4, -1)).toEqual([]);
  });

  it("retains only the newest sample at capacity 1", () => {
    expect(pushBounded([1], 2, 1)).toEqual([2]);
  });

  it("appends a null value so a gap is preserved as a hole", () => {
    expect(pushBounded<number | null>([1, 2], null, 5)).toEqual([1, 2, null]);
  });
});
