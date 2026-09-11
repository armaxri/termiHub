import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { TerminalSlot } from "./SplitView";

// FEC-012: TerminalSlot adopts the imperative xterm DOM element into its slot.
// When the element is not yet registered, adoption retries inside a RAF. That
// retry branch previously only cancelled the RAF on cleanup and never parked the
// element back — so an element adopted via the retry was left orphaned in a
// detached slot on unmount. These tests drive that exact path.

const parkingEl = document.createElement("div");
parkingEl.setAttribute("data-testid", "parking");
const termEl = document.createElement("div");
termEl.setAttribute("data-testid", "term");

// The registry hands out the xterm element; `null` until it is "registered".
let elementRegistered = false;
const getElement = vi.fn((_tabId: string) => (elementRegistered ? termEl : null));

vi.mock("@/components/Terminal/TerminalRegistry", () => ({
  useTerminalRegistry: () => ({
    getElement,
    focusTerminal: vi.fn(),
    fitTerminal: vi.fn(),
    parkingRef: { current: parkingEl },
  }),
}));

// TerminalSlot (and the SplitView module) read these; keep the slot in its plain
// state so no disconnect/reconnect overlay renders.
vi.mock("@/store/useSessionLifecycle", () => ({
  useProjectedSessionLifecycle: () => ({ reconnecting: false, exited: false }),
  useProjectedSessionLifecycleMaps: () => ({ terminalConnecting: {} }),
  useSessionAutoReconnect: () => undefined,
}));

let container: HTMLDivElement;
let root: Root;
let rafCallback: FrameRequestCallback | null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);

  // Reset the shared DOM fixtures: the element starts parked and unregistered.
  elementRegistered = false;
  parkingEl.appendChild(termEl);
  getElement.mockClear();

  // Capture the most recently scheduled RAF so the test can fire it manually.
  rafCallback = null;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    rafCallback = cb;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe("TerminalSlot RAF-path adoption (FEC-012)", () => {
  it("parks the element back to the parking node on unmount after a RAF-retry adoption", () => {
    // Mount while the element is NOT yet registered → adoption takes the RAF
    // retry branch (no synchronous adopt).
    act(() => {
      root.render(<TerminalSlot tabId="tab-1" isVisible={true} />);
    });
    const slotEl = container.querySelector(".terminal-container") as HTMLElement;
    expect(slotEl).not.toBeNull();
    // Not adopted yet: still parked, and a retry RAF is pending.
    expect(termEl.parentNode).toBe(parkingEl);
    expect(rafCallback).not.toBeNull();

    // The element registers, then the retry RAF fires → the slot adopts it.
    elementRegistered = true;
    act(() => {
      rafCallback?.(0);
    });
    expect(termEl.parentNode).toBe(slotEl);

    // Unmount: the RAF-branch cleanup must park the element back (the bug: it
    // used to only cancel the RAF, leaving the element orphaned in the slot).
    act(() => root.unmount());
    root = createRoot(container); // so afterEach's unmount is a no-op
    expect(termEl.parentNode).toBe(parkingEl);
  });

  it("is safe when the element is never adopted (RAF pending at unmount)", () => {
    // Element stays unregistered: the retry is scheduled but the slot never
    // adopts anything, so unmount must simply cancel the RAF and leave the
    // element parked — without throwing.
    act(() => {
      root.render(<TerminalSlot tabId="tab-2" isVisible={true} />);
    });
    expect(termEl.parentNode).toBe(parkingEl);
    expect(rafCallback).not.toBeNull();

    expect(() => {
      act(() => root.unmount());
    }).not.toThrow();
    root = createRoot(container);
    expect(termEl.parentNode).toBe(parkingEl);
    expect(cancelAnimationFrame).toHaveBeenCalled();
  });
});
