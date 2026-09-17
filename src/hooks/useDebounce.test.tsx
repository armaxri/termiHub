import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useDebounce, useDebouncedCallback, type DebouncedCallback } from "./useDebounce";

// ── useDebounce (value) ────────────────────────────────────────────────────────

/** Render useDebounce and expose its latest value + a way to change the source. */
function renderValue<T>(initial: T, delayMs: number) {
  const container = document.createElement("div");
  const root: Root = createRoot(container);
  let latest: T = initial;
  let current: T = initial;

  function Probe({ value }: { value: T }) {
    latest = useDebounce(value, delayMs);
    return null;
  }

  act(() => root.render(<Probe value={current} />));

  return {
    get: () => latest,
    setValue: (v: T) => {
      current = v;
      act(() => root.render(<Probe value={current} />));
    },
    unmount: () => act(() => root.unmount()),
  };
}

describe("useDebounce (value)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("returns the initial value immediately", () => {
    const hook = renderValue("a", 300);
    expect(hook.get()).toBe("a");
  });

  it("does not surface a new value until the delay elapses", () => {
    const hook = renderValue("a", 300);
    hook.setValue("b");
    expect(hook.get()).toBe("a");
    act(() => vi.advanceTimersByTime(299));
    expect(hook.get()).toBe("a");
    act(() => vi.advanceTimersByTime(1));
    expect(hook.get()).toBe("b");
  });

  it("restarts the timer on each change, surfacing only the last value", () => {
    const hook = renderValue("a", 300);
    hook.setValue("b");
    act(() => vi.advanceTimersByTime(200));
    hook.setValue("c");
    act(() => vi.advanceTimersByTime(200));
    // 400ms total elapsed, but only 200ms since the last change → still "a".
    expect(hook.get()).toBe("a");
    act(() => vi.advanceTimersByTime(100));
    expect(hook.get()).toBe("c");
  });

  it("does not update after unmount", () => {
    const hook = renderValue("a", 300);
    hook.setValue("b");
    hook.unmount();
    // Advancing timers must not throw or fire a post-unmount state update.
    act(() => vi.advanceTimersByTime(300));
    expect(hook.get()).toBe("a");
  });
});

// ── useDebouncedCallback ────────────────────────────────────────────────────────

/**
 * Render useDebouncedCallback and expose the returned debounced function. The
 * callback is captured from the latest render so identity-stability can be
 * verified across re-renders.
 */
function renderCallback<A extends unknown[]>(cb: (...args: A) => void, delayMs: number) {
  const container = document.createElement("div");
  const root: Root = createRoot(container);
  let debounced: DebouncedCallback<A> | undefined;
  let currentCb = cb;

  function Probe({ callback }: { callback: (...args: A) => void }) {
    debounced = useDebouncedCallback(callback, delayMs);
    return null;
  }

  act(() => root.render(<Probe callback={currentCb} />));

  return {
    call: (...args: A) => act(() => debounced!(...args)),
    cancel: () => act(() => debounced!.cancel()),
    flush: () => act(() => debounced!.flush()),
    fn: () => debounced!,
    rerender: (nextCb?: (...args: A) => void) => {
      if (nextCb) currentCb = nextCb;
      act(() => root.render(<Probe callback={currentCb} />));
    },
    unmount: () => act(() => root.unmount()),
  };
}

describe("useDebouncedCallback", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("invokes the callback once after the delay with the latest args", () => {
    const cb = vi.fn();
    const hook = renderCallback<[string]>(cb, 300);
    hook.call("first");
    hook.call("second");
    expect(cb).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(300));
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith("second");
  });

  it("cancel() drops a pending invocation", () => {
    const cb = vi.fn();
    const hook = renderCallback<[]>(cb, 300);
    hook.call();
    hook.cancel();
    act(() => vi.advanceTimersByTime(300));
    expect(cb).not.toHaveBeenCalled();
  });

  it("flush() runs a pending invocation immediately", () => {
    const cb = vi.fn();
    const hook = renderCallback<[number]>(cb, 300);
    hook.call(42);
    hook.flush();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(42);
    // The timer was cleared, so no second call fires.
    act(() => vi.advanceTimersByTime(300));
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("flush() is a no-op when nothing is pending", () => {
    const cb = vi.fn();
    const hook = renderCallback<[]>(cb, 300);
    hook.flush();
    expect(cb).not.toHaveBeenCalled();
  });

  it("keeps a stable function identity across re-renders", () => {
    const hook = renderCallback<[]>(vi.fn(), 300);
    const first = hook.fn();
    hook.rerender();
    expect(hook.fn()).toBe(first);
  });

  it("always calls the latest callback", () => {
    const first = vi.fn();
    const second = vi.fn();
    const hook = renderCallback<[]>(first, 300);
    hook.call();
    hook.rerender(second);
    act(() => vi.advanceTimersByTime(300));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("does not fire after unmount", () => {
    const cb = vi.fn();
    const hook = renderCallback<[]>(cb, 300);
    hook.call();
    hook.unmount();
    act(() => vi.advanceTimersByTime(300));
    expect(cb).not.toHaveBeenCalled();
  });

  it("clears the pending timer on unmount (no timer leaks)", () => {
    const hook = renderCallback<[]>(vi.fn(), 300);
    hook.call();
    // The armed timer is live before unmount…
    expect(vi.getTimerCount()).toBe(1);
    hook.unmount();
    // …and the cleanup must have cleared it, so nothing lingers past unmount.
    expect(vi.getTimerCount()).toBe(0);
  });
});
