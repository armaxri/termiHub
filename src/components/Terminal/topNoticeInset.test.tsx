/**
 * The top-notice inset must not write from inside a ResizeObserver delivery (#5948).
 *
 * The inset moves the xterm element's `top`, which `Terminal.tsx` observes with its
 * own ResizeObserver. Writing it synchronously from the notice's observer callback
 * resizes an observed element in the same delivery cycle, and WebKit reports
 * "ResizeObserver loop completed with undelivered notifications". The hook defers
 * the write to the next animation frame and skips no-op writes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TOP_NOTICE_INSET_VAR, useTopNoticeInset } from "./topNoticeInset";

type RoCallback = (entries: ResizeObserverEntry[], observer: ResizeObserver) => void;

let roCallbacks: RoCallback[] = [];
let rafQueue: Map<number, FrameRequestCallback>;
let nextRaf = 1;

class FakeResizeObserver {
  constructor(private readonly cb: RoCallback) {
    roCallbacks.push(cb);
  }
  observe() {}
  unobserve() {}
  disconnect() {
    roCallbacks = roCallbacks.filter((c) => c !== this.cb);
  }
}

function deliverResize() {
  for (const cb of [...roCallbacks]) cb([], {} as ResizeObserver);
}

function flushFrames() {
  const frames = [...rafQueue.values()];
  rafQueue.clear();
  for (const f of frames) f(0);
}

let height = 20;

function Notice() {
  const ref = useRef<HTMLDivElement>(null);
  useTopNoticeInset(ref);
  return <div ref={ref} />;
}

let container: HTMLDivElement;
let root: Root;

function renderInSlot(): { host: HTMLElement; unmount: () => void } {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <div className="terminal-context-trigger">
        <Notice />
      </div>
    );
  });
  const host = container.querySelector<HTMLElement>(".terminal-context-trigger")!;
  return { host, unmount: () => act(() => root.unmount()) };
}

beforeEach(() => {
  roCallbacks = [];
  rafQueue = new Map();
  nextRaf = 1;
  height = 20;
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const id = nextRaf++;
    rafQueue.set(id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    rafQueue.delete(id);
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(() => height);
});

afterEach(() => {
  container?.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useTopNoticeInset (#5948)", () => {
  it("publishes the initial height synchronously on mount", () => {
    const { host } = renderInSlot();
    expect(host.style.getPropertyValue(TOP_NOTICE_INSET_VAR)).toBe("20px");
  });

  it("does not write the inset synchronously from the observer callback", () => {
    const { host } = renderInSlot();
    const setProperty = vi.spyOn(host.style, "setProperty");
    height = 44;
    deliverResize();
    expect(setProperty).not.toHaveBeenCalled();
    expect(host.style.getPropertyValue(TOP_NOTICE_INSET_VAR)).toBe("20px");
    flushFrames();
    expect(host.style.getPropertyValue(TOP_NOTICE_INSET_VAR)).toBe("44px");
  });

  it("skips the write when the height is unchanged", () => {
    const { host } = renderInSlot();
    const setProperty = vi.spyOn(host.style, "setProperty");
    deliverResize();
    flushFrames();
    expect(setProperty).not.toHaveBeenCalled();
  });

  it("coalesces several deliveries into one frame", () => {
    renderInSlot();
    height = 30;
    deliverResize();
    deliverResize();
    deliverResize();
    expect(rafQueue.size).toBe(1);
  });

  it("cancels a pending frame and clears the inset on unmount", () => {
    const { host, unmount } = renderInSlot();
    height = 50;
    deliverResize();
    expect(rafQueue.size).toBe(1);
    unmount();
    expect(rafQueue.size).toBe(0);
    expect(host.style.getPropertyValue(TOP_NOTICE_INSET_VAR)).toBe("");
  });
});
