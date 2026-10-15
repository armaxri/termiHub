import { act } from "react";

/**
 * A controllable `ResizeObserver` double for width-responsive component tests
 * (#4709). jsdom has no layout, so the global stub never reports a size; this
 * one records every observed element and lets a test report a content width
 * for all of them at once, the way a sidebar resize would.
 *
 * ```ts
 * const ro = installResizeObserverMock();
 * render(...);
 * ro.resize(184); // every observed element now reports 184px
 * ro.restore();
 * ```
 */
export interface ResizeObserverMock {
  /** Report `width` (px) for every currently observed element. */
  resize(width: number): void;
  /** Put the previous `ResizeObserver` back. */
  restore(): void;
}

/** Install the controllable double over `globalThis.ResizeObserver`. */
export function installResizeObserverMock(): ResizeObserverMock {
  const previous = globalThis.ResizeObserver;
  const observers = new Set<MockResizeObserver>();

  class MockResizeObserver {
    readonly targets = new Set<Element>();
    constructor(private readonly callback: ResizeObserverCallback) {
      observers.add(this);
    }
    observe(target: Element): void {
      this.targets.add(target);
    }
    unobserve(target: Element): void {
      this.targets.delete(target);
    }
    disconnect(): void {
      this.targets.clear();
      observers.delete(this);
    }
    fire(width: number): void {
      const entries = Array.from(this.targets).map(
        (target) =>
          ({
            target,
            contentRect: { width, height: 0 } as DOMRectReadOnly,
          }) as ResizeObserverEntry
      );
      if (entries.length > 0) {
        this.callback(entries, this as unknown as ResizeObserver);
      }
    }
  }

  globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;

  return {
    resize(width: number) {
      act(() => {
        for (const observer of Array.from(observers)) observer.fire(width);
      });
    },
    restore() {
      globalThis.ResizeObserver = previous;
    },
  };
}
