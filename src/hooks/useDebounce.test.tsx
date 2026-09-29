import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  useDebounce,
  useDebouncedCallback,
  useKeyedDebouncedCallback,
  type DebouncedCallback,
  type DebounceOptions,
  type KeyedDebouncedCallback,
  type KeyedDebounceOptions,
} from "./useDebounce";

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
function renderCallback<A extends unknown[]>(
  cb: (...args: A) => void,
  delayMs: number,
  options?: DebounceOptions<A>
) {
  const container = document.createElement("div");
  const root: Root = createRoot(container);
  let debounced: DebouncedCallback<A> | undefined;
  let currentCb = cb;

  function Probe({ callback }: { callback: (...args: A) => void }) {
    debounced = useDebouncedCallback(callback, delayMs, options);
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

describe("useDebouncedCallback options (onFlush / flushOnUnmount)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("flush() runs onFlush (not the callback) with the pending args", () => {
    const cb = vi.fn();
    const onFlush = vi.fn();
    const hook = renderCallback<[string]>(cb, 300, { onFlush });
    hook.call("a");
    hook.call("b");
    hook.flush();
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith("b");
    expect(cb).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(300));
    expect(cb).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a normal timer fire still runs the callback, not onFlush", () => {
    const cb = vi.fn();
    const onFlush = vi.fn();
    const hook = renderCallback<[number]>(cb, 300, { onFlush });
    hook.call(1);
    act(() => vi.advanceTimersByTime(300));
    expect(cb).toHaveBeenCalledWith(1);
    expect(onFlush).not.toHaveBeenCalled();
  });

  it("flushOnUnmount runs the pending invocation through onFlush on unmount", () => {
    const cb = vi.fn();
    const onFlush = vi.fn();
    const hook = renderCallback<[string]>(cb, 300, { onFlush, flushOnUnmount: true });
    hook.call("last");
    hook.unmount();
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith("last");
    expect(cb).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("flushOnUnmount without onFlush runs the callback on unmount", () => {
    const cb = vi.fn();
    const hook = renderCallback<[number]>(cb, 300, { flushOnUnmount: true });
    hook.call(7);
    hook.unmount();
    expect(cb).toHaveBeenCalledWith(7);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("flushOnUnmount is a no-op on unmount when nothing is pending", () => {
    const cb = vi.fn();
    const onFlush = vi.fn();
    const hook = renderCallback<[]>(cb, 300, { onFlush, flushOnUnmount: true });
    hook.call();
    act(() => vi.advanceTimersByTime(300));
    hook.unmount();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(onFlush).not.toHaveBeenCalled();
  });
});

// ── useKeyedDebouncedCallback ──────────────────────────────────────────────────

function renderKeyed<A extends unknown[]>(
  cb: (key: string, ...args: A) => void,
  delayMs: number,
  options?: KeyedDebounceOptions<string, A>
) {
  const container = document.createElement("div");
  const root: Root = createRoot(container);
  let debounced: KeyedDebouncedCallback<string, A> | undefined;

  function Probe() {
    debounced = useKeyedDebouncedCallback(cb, delayMs, options);
    return null;
  }

  act(() => root.render(<Probe />));

  return {
    call: (key: string, ...args: A) => act(() => debounced!(key, ...args)),
    fn: () => debounced!,
    rerender: () => act(() => root.render(<Probe />)),
    unmount: () => act(() => root.unmount()),
  };
}

describe("useKeyedDebouncedCallback", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("coalesces calls per key and keeps keys independent", () => {
    const cb = vi.fn();
    const hook = renderKeyed<[number]>(cb, 300);
    hook.call("a", 1);
    act(() => vi.advanceTimersByTime(200));
    hook.call("b", 10);
    hook.call("a", 2);
    // "a" was re-armed at t=200, "b" armed at t=200: neither has fired yet.
    act(() => vi.advanceTimersByTime(299));
    expect(cb).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenCalledWith("a", 2);
    expect(cb).toHaveBeenCalledWith("b", 10);
  });

  it("re-arming one key does not delay another", () => {
    const cb = vi.fn();
    const hook = renderKeyed<[]>(cb, 300);
    hook.call("a");
    act(() => vi.advanceTimersByTime(200));
    hook.call("b");
    act(() => vi.advanceTimersByTime(100));
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith("a");
    act(() => vi.advanceTimersByTime(200));
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenLastCalledWith("b");
  });

  it("cancel(key) drops only that key; cancel() drops all", () => {
    const cb = vi.fn();
    const hook = renderKeyed<[]>(cb, 300);
    hook.call("a");
    hook.call("b");
    hook.call("c");
    act(() => hook.fn().cancel("a"));
    act(() => vi.advanceTimersByTime(300));
    expect(cb.mock.calls.map((c) => c[0]).sort()).toEqual(["b", "c"]);

    cb.mockClear();
    hook.call("a");
    hook.call("b");
    act(() => hook.fn().cancel());
    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.advanceTimersByTime(300));
    expect(cb).not.toHaveBeenCalled();
  });

  it("flush(key) runs only that key through onFlush; flush() runs all", () => {
    const cb = vi.fn();
    const onFlush = vi.fn();
    const hook = renderKeyed<[number]>(cb, 300, { onFlush });
    hook.call("a", 1);
    hook.call("b", 2);
    act(() => hook.fn().flush("a"));
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith("a", 1);
    act(() => hook.fn().flush());
    expect(onFlush).toHaveBeenCalledTimes(2);
    expect(onFlush).toHaveBeenLastCalledWith("b", 2);
    act(() => vi.advanceTimersByTime(300));
    expect(cb).not.toHaveBeenCalled();
  });

  it("keeps a stable function identity across re-renders", () => {
    const hook = renderKeyed<[]>(vi.fn(), 300);
    const first = hook.fn();
    hook.rerender();
    expect(hook.fn()).toBe(first);
  });

  it("cancels every pending key on unmount by default (no timer leaks)", () => {
    const cb = vi.fn();
    const hook = renderKeyed<[]>(cb, 300);
    hook.call("a");
    hook.call("b");
    expect(vi.getTimerCount()).toBe(2);
    hook.unmount();
    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.advanceTimersByTime(300));
    expect(cb).not.toHaveBeenCalled();
  });

  it("flushes every pending key on unmount with flushOnUnmount", () => {
    const cb = vi.fn();
    const hook = renderKeyed<[number]>(cb, 300, { flushOnUnmount: true });
    hook.call("a", 1);
    hook.call("b", 2);
    hook.unmount();
    expect(cb).toHaveBeenCalledWith("a", 1);
    expect(cb).toHaveBeenCalledWith("b", 2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
