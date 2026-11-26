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
    vi.useFakeTimers();
    let done = false;
    debounceWrite(
      "a",
      300,
      () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            done = true;
            resolve();
          }, 10)
        )
    );
    const b = vi.fn();
    debounceWrite("b", 300, b);
    const flushed = flushDebouncedWrites();
    expect(b).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10);
    await flushed;
    expect(done).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(b).toHaveBeenCalledOnce();
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
