import { describe, it, expect, afterEach, vi } from "vitest";
import { useRef, act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useVirtualizer } from "@tanstack/react-virtual";
import { installVirtualListSizing, setElementSize } from "./virtualListSize";

/**
 * Tests for the opt-in jsdom virtual-list sizing helper (audit finding MOCK-008)
 * and a regression guard that `@tanstack/virtual-core` clears its scroll-reset
 * debounce timer on unmount without any global `onscrollend` shim (#3056).
 */

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const uninstallers: Array<() => void> = [];

afterEach(() => {
  if (root) {
    act(() => root!.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  while (uninstallers.length) uninstallers.pop()!();
  vi.useRealTimers();
});

/** Track an installer so it is always torn down after the test. */
function install(...args: Parameters<typeof installVirtualListSizing>): () => void {
  const uninstall = installVirtualListSizing(...args);
  uninstallers.push(uninstall);
  return uninstall;
}

/**
 * Minimal virtualized list built on the real `useVirtualizer`, so the regression
 * exercises the same scroll-listener/debounce machinery the FileBrowser uses. The
 * `useScrollendEvent` flag lets a test pick the native-scrollend opt-in (what the
 * FileBrowser uses) or the plain debounce default.
 */
function VirtualProbe({ useScrollendEvent }: { useScrollendEvent: boolean }) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: 1000,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 40,
    overscan: 8,
    useScrollendEvent,
  });
  return (
    <div ref={parentRef} data-testid="scroll" className="virtual-probe">
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((item) => (
          <div
            key={item.key}
            data-testid={`row-${item.index}`}
            style={{ transform: `translateY(${item.start}px)` }}
          >
            row {item.index}
          </div>
        ))}
      </div>
    </div>
  );
}

function render(node: React.ReactElement): HTMLElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(node));
  return container;
}

describe("virtualListSize helper (MOCK-008)", () => {
  it("sizes only class-matched elements and restores prototypes on uninstall", () => {
    install({ listClass: "probe-list", innerClass: "probe-inner", height: 1234, width: 56 });

    const list = document.createElement("div");
    list.className = "probe-list";
    const inner = document.createElement("div");
    inner.className = "probe-inner";
    inner.style.height = "9000px";
    list.appendChild(inner);
    document.body.appendChild(list);

    // The class-matched scroll viewport reports the explicit size the test asked
    // for; scrollHeight mirrors the inner spacer's declared height.
    expect(list.clientHeight).toBe(1234);
    expect(list.offsetHeight).toBe(1234);
    expect(list.clientWidth).toBe(56);
    expect(list.offsetWidth).toBe(56);
    expect(list.scrollHeight).toBe(9000);

    // scrollTop/scrollLeft are backed by real storage (jsdom's are inert no-ops).
    list.scrollTop = 42;
    expect(list.scrollTop).toBe(42);

    // A non-matching element keeps jsdom's real zero size — the size is scoped,
    // not a hidden global applied to every element under test (the MOCK-008 fix).
    const other = document.createElement("div");
    document.body.appendChild(other);
    expect(other.clientHeight).toBe(0);
    expect(other.offsetWidth).toBe(0);

    // Uninstalling restores jsdom's real prototype behaviour (size back to 0).
    while (uninstallers.length) uninstallers.pop()!();
    expect(list.clientHeight).toBe(0);
    expect(list.offsetWidth).toBe(0);

    list.remove();
    other.remove();
  });

  it("sizes a single element via setElementSize", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    expect(el.clientHeight).toBe(0);

    setElementSize(el, { width: 320, height: 480, scrollHeight: 5000 });
    expect(el.clientHeight).toBe(480);
    expect(el.offsetWidth).toBe(320);
    expect(el.scrollHeight).toBe(5000);

    el.remove();
  });
});

describe("react-virtual scroll-timer cleanup (#3056)", () => {
  // `@tanstack/virtual-core` < 3.17.8 armed a 150ms `isScrolling` reset debounce
  // on every scroll whose unmount cleanup never cleared it, so a list unmounted
  // mid-scroll left a timer that later fired on a torn-down tree (under jsdom: an
  // unhandled "window is not defined"). We used to steer every virtualizer onto
  // the native-scrollend path with a global `onscrollend` shim in
  // `src/test/setup.ts`; the pinned version now cancels the debounce in its own
  // cleanup, so the plain debounce path is safe on its own and the shim is gone.
  it("unmounting mid-scroll leaves no pending timers on the debounce path", () => {
    vi.useFakeTimers();
    const el = render(<VirtualProbe useScrollendEvent={false} />);
    const scroll = el.querySelector('[data-testid="scroll"]') as HTMLElement;
    expect(vi.getTimerCount()).toBe(0);

    act(() => {
      scroll.dispatchEvent(new Event("scroll"));
    });
    // The scroll armed the isScrolling reset debounce — we are mid-scroll.
    expect(vi.getTimerCount()).toBe(1);

    act(() => root!.unmount());
    root = null;
    // Unmount cancelled it: nothing is left to fire on the torn-down tree.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("unmounting mid-scroll leaves no pending timers on the scrollend path", () => {
    // What the FileBrowser opts into. jsdom implements `onscrollend` natively, so
    // no debounce is armed at all — asserted without any shim in setup.ts.
    vi.useFakeTimers();
    const el = render(<VirtualProbe useScrollendEvent={true} />);
    const scroll = el.querySelector('[data-testid="scroll"]') as HTMLElement;

    act(() => {
      scroll.dispatchEvent(new Event("scroll"));
    });
    expect(vi.getTimerCount()).toBe(0);

    act(() => root!.unmount());
    root = null;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still resets isScrolling after the debounce while mounted", () => {
    vi.useFakeTimers();
    const el = render(<VirtualProbe useScrollendEvent={false} />);
    const scroll = el.querySelector('[data-testid="scroll"]') as HTMLElement;

    act(() => {
      scroll.dispatchEvent(new Event("scroll"));
    });
    expect(vi.getTimerCount()).toBe(1);

    // Letting the debounce elapse while mounted fires it normally.
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
