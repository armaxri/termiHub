/**
 * #5620: after an automatic reconnect the terminal painted blank although its
 * buffer held the scrollback and the new prompt.
 *
 * A reconnect re-runs the Terminal's creation effect (the retry counter is one
 * of its deps): the old xterm element is disposed and removed, and a fresh one
 * is created and *parked* off screen until a `TerminalSlot` adopts it. A user
 * reconnect swaps the slot for the connecting overlay and back, so the slot
 * remounts and adopts the new element. The automatic (backend-driven) reconnect
 * keeps the slot mounted under the non-blocking reconnect strip, so nothing
 * adopted the new element: it stayed parked and the visible pane stayed empty.
 *
 * These tests drive the real registry + slot through that exact re-registration.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import type { Terminal as XTerm } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { TerminalSlot } from "./SplitView";
import {
  TerminalPortalProvider,
  useTerminalRegistry,
} from "@/components/Terminal/TerminalRegistry";

// Keep the slot in its plain state: no overlay of any kind renders.
vi.mock("@/store/useSessionLifecycle", () => ({
  useProjectedSessionLifecycle: () => ({ reconnecting: false, exited: false, evicted: false }),
  useProjectedSessionLifecycleMaps: () => ({ terminalConnecting: {} }),
  useSessionAutoReconnect: () => undefined,
}));

const TAB = "tab-readopt";

type Registry = ReturnType<typeof useTerminalRegistry>;
let registry: Registry | null = null;

/** Captures the live registry so the test can play the Terminal's part. */
function GrabRegistry() {
  registry = useTerminalRegistry();
  return null;
}

function fakeXterm(): XTerm {
  return {
    focus: vi.fn(),
    buffer: { active: { viewportY: 0, baseY: 0 } },
  } as unknown as XTerm;
}

function fakeFit(): FitAddon {
  return { fit: vi.fn(), proposeDimensions: () => undefined } as unknown as FitAddon;
}

/** Mimic the Terminal's creation effect: create, park, register an element. */
function mountTerminalElement(): HTMLDivElement {
  const el = document.createElement("div");
  act(() => {
    registry!.parkingRef.current!.appendChild(el);
    registry!.register(TAB, el, fakeXterm(), fakeFit());
  });
  return el;
}

/** Mimic the creation effect's cleanup on a reconnect re-run. */
function disposeTerminalElement(el: HTMLDivElement): void {
  registry!.unregister(TAB);
  el.remove();
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  registry = null;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function renderSlot() {
  act(() => {
    root.render(
      <TerminalPortalProvider>
        <GrabRegistry />
        <TerminalSlot tabId={TAB} isVisible={true} />
      </TerminalPortalProvider>
    );
  });
  const slotEl = container.querySelector(".terminal-container");
  expect(slotEl).not.toBeNull();
  return slotEl as HTMLElement;
}

describe("TerminalSlot re-adopts a re-registered terminal element (#5620)", () => {
  it("adopts the fresh element a reconnect registers while the slot stays mounted", () => {
    const slotEl = renderSlot();

    // Initial mount: the first element is adopted.
    const first = mountTerminalElement();
    expect(first.parentNode).toBe(slotEl);

    // Automatic reconnect: the creation effect re-runs with the slot mounted.
    act(() => {
      disposeTerminalElement(first);
    });
    const second = mountTerminalElement();

    // The bug: the fresh element stayed parked off screen → a blank pane.
    expect(second.parentNode).toBe(slotEl);
    expect(registry!.parkingRef.current!.contains(second)).toBe(false);
  });

  it("adopts an element that registers after the slot mounted (no RAF luck needed)", () => {
    // RAF never fires here: only a registration notification can adopt.
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1)
    );
    const slotEl = renderSlot();
    const el = mountTerminalElement();
    expect(el.parentNode).toBe(slotEl);
  });

  it("stops listening once the slot unmounts", () => {
    renderSlot();
    act(() => root.unmount());
    root = createRoot(container);
    // Re-mount only the provider so the registry outlives the slot.
    act(() => {
      root.render(
        <TerminalPortalProvider>
          <GrabRegistry />
        </TerminalPortalProvider>
      );
    });
    const el = mountTerminalElement();
    expect(registry!.parkingRef.current!.contains(el)).toBe(true);
  });
});
