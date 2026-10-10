import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { abortableDelay } from "./abortableDelay";

describe("abortableDelay (#4381)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves true once the full delay elapses", async () => {
    const onDone = vi.fn();
    void abortableDelay(3000, new AbortController().signal).then(onDone);
    await vi.advanceTimersByTimeAsync(2999);
    expect(onDone).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onDone).toHaveBeenCalledWith(true);
  });

  it("resolves false the moment the signal aborts, without waiting out the delay", async () => {
    const ctrl = new AbortController();
    const onDone = vi.fn();
    void abortableDelay(3000, ctrl.signal).then(onDone);
    await vi.advanceTimersByTimeAsync(10);
    ctrl.abort();
    // No timer advance: the abort event alone settles the wait.
    await Promise.resolve();
    await Promise.resolve();
    expect(onDone).toHaveBeenCalledWith(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resolves false immediately for an already-aborted signal and starts no timer", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(abortableDelay(3000, ctrl.signal)).resolves.toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not poll: only the single delay timer is pending while waiting", async () => {
    void abortableDelay(2500, new AbortController().signal);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("works without a signal", async () => {
    const p = abortableDelay(100);
    await vi.advanceTimersByTimeAsync(100);
    await expect(p).resolves.toBe(true);
  });
});
