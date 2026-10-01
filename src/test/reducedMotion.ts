import { vi } from "vitest";
import { REDUCED_MOTION_QUERY } from "@/hooks/usePrefersReducedMotion";

/**
 * Controller returned by {@link mockReducedMotion}: flip the OS "reduce motion"
 * preference mid-test and restore the original `window.matchMedia` afterwards.
 */
export interface ReducedMotionMock {
  /** Change the preference and notify `change` listeners (wrap in `act`). */
  set(reduced: boolean): void;
  /** Restore the `window.matchMedia` that was installed before the mock. */
  restore(): void;
}

/**
 * Stub `window.matchMedia` so `(prefers-reduced-motion: reduce)` matches
 * `reduced` (every other query reports `false`). Listeners registered through
 * `addEventListener("change")` / `addListener` are notified by `set()`.
 */
export function mockReducedMotion(reduced: boolean): ReducedMotionMock {
  const original = window.matchMedia;
  let current = reduced;
  const listeners = new Set<() => void>();

  window.matchMedia = vi.fn((query: string) => {
    const isReducedQuery = query === REDUCED_MOTION_QUERY;
    return {
      get matches() {
        return isReducedQuery && current;
      },
      media: query,
      onchange: null,
      addListener: (cb: () => void) => listeners.add(cb),
      removeListener: (cb: () => void) => listeners.delete(cb),
      addEventListener: (_type: string, cb: () => void) => listeners.add(cb),
      removeEventListener: (_type: string, cb: () => void) => listeners.delete(cb),
      dispatchEvent: () => false,
    } as unknown as MediaQueryList;
  });

  return {
    set(next: boolean) {
      current = next;
      for (const cb of [...listeners]) cb();
    },
    restore() {
      window.matchMedia = original;
    },
  };
}
