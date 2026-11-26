import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cancelDebouncedWrite,
  cancelDebouncedWrites,
  debounceWrite,
  flushDebouncedWrites,
} from "./debouncedWrites";

describe("debounced writes (#6094)", () => {
  afterEach(() => {
    cancelDebouncedWrites();
    vi.useRealTimers();
  });

  it("writes the last one of a key once the time has passed", () => {
    vi.useFakeTimers();
    const first = vi.fn();
    const last = vi.fn();
    debounceWrite("k", 300, first);
    debounceWrite("k", 300, last);
    vi.advanceTimersByTime(299);
    expect(last).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(first).not.toHaveBeenCalled();
    expect(last).toHaveBeenCalledOnce();
  });

  it("writes every key that waits when flushed, and waits for them", async () => {
    let finish = () => {};
    debounceWrite("a", 300, () => new Promise<void>((resolve) => (finish = resolve)));
    const b = vi.fn();
    debounceWrite("b", 300, b);
    let flushed = false;
    const flushing = flushDebouncedWrites().then(() => (flushed = true));
    expect(b).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(flushed).toBe(false);
    finish();
    await flushing;
    expect(flushed).toBe(true);
  });

  it("writes nothing again once a write was made", async () => {
    vi.useFakeTimers();
    const a = vi.fn();
    debounceWrite("a", 300, a);
    vi.advanceTimersByTime(300);
    await flushDebouncedWrites();
    expect(a).toHaveBeenCalledOnce();
  });

  it("swallows a write that fails later, in its timer and in a flush", async () => {
    const failed = vi.fn();
    process.on("unhandledRejection", failed);
    try {
      debounceWrite("a", 1, () => Promise.reject(new Error("later")));
      await new Promise((resolve) => setTimeout(resolve, 5));
      debounceWrite("a", 1, () => Promise.reject(new Error("later")));
      await flushDebouncedWrites();
      await new Promise((resolve) => setImmediate(resolve));
      expect(failed).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", failed);
    }
  });

  it("drops one key, or all of them", () => {
    vi.useFakeTimers();
    const a = vi.fn();
    const b = vi.fn();
    debounceWrite("a", 300, a);
    debounceWrite("b", 300, b);
    cancelDebouncedWrite("a");
    vi.advanceTimersByTime(300);
    expect([a.mock.calls.length, b.mock.calls.length]).toEqual([0, 1]);
    debounceWrite("a", 300, a);
    cancelDebouncedWrites();
    vi.advanceTimersByTime(300);
    expect(a).not.toHaveBeenCalled();
  });

  it("never throws out of its timer or a flush", async () => {
    vi.useFakeTimers();
    debounceWrite("sync", 1, () => {
      throw new Error("at once");
    });
    debounceWrite("async", 1, () => Promise.reject(new Error("later")));
    expect(() => vi.advanceTimersByTime(1)).not.toThrow();
    debounceWrite("sync", 1, () => {
      throw new Error("at once");
    });
    await expect(flushDebouncedWrites()).resolves.toBeUndefined();
  });
});
