import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useElapsed } from "./useElapsed";

/**
 * Renders the hook into a throwaway component and mirrors its return value onto
 * a closure so assertions can read the latest elapsed value without JSX/testids.
 */
function renderHook(active: boolean): { get: () => number; setActive: (a: boolean) => void } {
  const container = document.createElement("div");
  const root: Root = createRoot(container);
  let latest = 0;
  let current = active;

  function Probe({ active: a }: { active: boolean }) {
    latest = useElapsed(a);
    return null;
  }

  act(() => root.render(<Probe active={current} />));

  return {
    get: () => latest,
    setActive: (a: boolean) => {
      current = a;
      act(() => root.render(<Probe active={current} />));
    },
  };
}

describe("useElapsed", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts at 0 seconds when active", () => {
    const hook = renderHook(true);
    expect(hook.get()).toBe(0);
  });

  it("ticks up one second at a time while active", () => {
    const hook = renderHook(true);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(hook.get()).toBe(3);
  });

  it("returns 0 and stops ticking when inactive", () => {
    const hook = renderHook(false);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(hook.get()).toBe(0);
  });

  it("resets to 0 when reactivated", () => {
    const hook = renderHook(true);
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(hook.get()).toBe(4);
    hook.setActive(false);
    expect(hook.get()).toBe(0);
    hook.setActive(true);
    expect(hook.get()).toBe(0);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(hook.get()).toBe(2);
  });
});
