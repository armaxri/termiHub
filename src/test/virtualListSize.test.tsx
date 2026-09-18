import { describe, it, expect, afterEach, vi } from "vitest";
import { useRef, act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useVirtualizer } from "@tanstack/react-virtual";
import { installVirtualListSizing, setElementSize } from "./virtualListSize";

/**
 * Tests for the opt-in jsdom virtual-list sizing helper (audit finding MOCK-008)
 * and a regression guard for the `@tanstack/virtual-core` debounce-timer leak the
 * global `onscrollend` shim in `src/test/setup.ts` compensates for.
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
 * `useScrollendEvent` flag lets a test pick the native-scrollend path (what the
 * FileBrowser opts into) or the debounce fallback (the leaky default).
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

describe("react-virtual scroll-timer leak (MOCK-008 / onscrollend shim)", () => {
  it("leaves no pending debounce timer after unmount on the scrollend path", () => {
    // The FileBrowser sets useScrollendEvent: true and setup.ts advertises
    // `onscrollend`, so virtual-core resets isScrolling from the native scrollend
    // event and never arms the leaky 150ms debounce. Assert that: a scroll then
    // an unmount leaves zero pending timers.
    vi.useFakeTimers();
    const el = render(<VirtualProbe useScrollendEvent={true} />);
    const scroll = el.querySelector('[data-testid="scroll"]') as HTMLElement;

    act(() => {
      scroll.dispatchEvent(new Event("scroll"));
    });
    // No debounce timer is armed on the scrollend path.
    expect(vi.getTimerCount()).toBe(0);

    act(() => root!.unmount());
    root = null;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("documents the dependency leak: the debounce fallback survives unmount", () => {
    // Control case proving the leak is real and lives in virtual-core, not our
    // code: with the debounce fallback (useScrollendEvent: false), a scroll arms a
    // setTimeout whose cleanup on unmount never clears it — the timer outlives the
    // component. In the running app this fires a state update on a torn-down tree;
    // under jsdom, once the environment is disposed between test files, it throws
    // an unhandled "window is not defined". The onscrollend shim steers around it.
    vi.useFakeTimers();
    const el = render(<VirtualProbe useScrollendEvent={false} />);
    const scroll = el.querySelector('[data-testid="scroll"]') as HTMLElement;

    act(() => {
      scroll.dispatchEvent(new Event("scroll"));
    });
    // The scroll armed the debounce timer.
    expect(vi.getTimerCount()).toBe(1);

    act(() => root!.unmount());
    root = null;
    // Unmount did NOT clear it — this is the leak the shim compensates for.
    expect(vi.getTimerCount()).toBe(1);

    vi.clearAllTimers();
  });
});
