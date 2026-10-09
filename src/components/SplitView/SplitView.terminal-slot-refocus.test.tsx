/**
 * #4513: after a successful reconnect from a connection-state overlay, focus
 * returns to the terminal — but only when focus is unclaimed (the page body or
 * still inside the tab's panel), never taken from a dialog or another panel.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { TerminalSlot } from "./SplitView";
import {
  consumeTerminalRefocusPending,
  markTerminalRefocusPending,
} from "@/components/Terminal/terminalRefocus";

const focusTerminal = vi.fn();

vi.mock("@/components/Terminal/TerminalRegistry", () => ({
  useTerminalRegistry: () => ({
    getElement: () => null,
    focusTerminal,
    fitTerminal: vi.fn(),
    parkingRef: { current: null },
    clearTerminal: vi.fn(),
  }),
}));

// Mutable lifecycle the slot reads; tests flip it and re-render.
const life = { reconnecting: false, exited: false, evicted: false };

vi.mock("@/store/useSessionLifecycle", () => ({
  useProjectedSessionLifecycle: () => ({ ...life }),
  useProjectedSessionLifecycleMaps: () => ({ terminalConnecting: {} }),
  useSessionAutoReconnect: () => undefined,
}));

// The real overlay needs the session region; a focusable stand-in is enough to
// model "focus sat on the overlay's primary action".
vi.mock("@/components/Terminal/TerminalDisconnectOverlay", () => ({
  TerminalDisconnectOverlay: () => (
    <button type="button" data-testid="overlay-primary">
      Reconnect
    </button>
  ),
}));

const TAB = "tab-refocus";

let container: HTMLDivElement;
let panel: HTMLDivElement;
let outside: HTMLButtonElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  // The panel content is the overlay host, as in SplitView.
  panel = document.createElement("div");
  panel.setAttribute("data-overlay-host", "");
  container.appendChild(panel);
  // A control outside the panel (a dialog, the sidebar or another panel).
  outside = document.createElement("button");
  outside.textContent = "elsewhere";
  container.appendChild(outside);
  document.body.appendChild(container);
  root = createRoot(panel);
  Object.assign(life, { reconnecting: false, exited: false, evicted: false });
  consumeTerminalRefocusPending(TAB);
  focusTerminal.mockClear();
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function render(isVisible = true): void {
  act(() => {
    root.render(<TerminalSlot tabId={TAB} isVisible={isVisible} />);
  });
}

/** Mount with the disconnect overlay up, focus on its primary action. */
function mountDisconnected(isVisible = true): void {
  life.exited = true;
  render(isVisible);
  const primary = panel.querySelector<HTMLElement>("[data-testid='overlay-primary']");
  expect(primary).not.toBeNull();
  primary?.focus();
  focusTerminal.mockClear();
}

/** The session reconnected: the overlay unmounts. */
function reconnect(isVisible = true): void {
  life.exited = false;
  life.reconnecting = false;
  render(isVisible);
}

describe("TerminalSlot refocus after the disconnect overlay closes (#4513)", () => {
  it("focuses the terminal when focus fell to the body", () => {
    mountDisconnected();
    reconnect();
    // The overlay's button left the DOM, so focus is on the body.
    expect(document.activeElement).toBe(document.body);
    expect(focusTerminal).toHaveBeenCalledWith(TAB);
  });

  it("focuses the terminal when focus is still inside the tab's panel", () => {
    mountDisconnected();
    const inPanel = document.createElement("button");
    panel.appendChild(inPanel);
    inPanel.focus();
    reconnect();
    expect(focusTerminal).toHaveBeenCalledWith(TAB);
    inPanel.remove();
  });

  it("does not steal focus from a dialog or another panel", () => {
    mountDisconnected();
    outside.focus();
    reconnect();
    expect(focusTerminal).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(outside);
  });

  it("does not focus a background tab", () => {
    mountDisconnected(false);
    reconnect(false);
    expect(focusTerminal).not.toHaveBeenCalled();
  });

  it("does not focus when the overlay closed without reconnecting (evicted)", () => {
    mountDisconnected();
    life.evicted = true;
    render();
    expect(focusTerminal).not.toHaveBeenCalled();
  });
});

describe("TerminalSlot refocus after the connection overlay closes (#4513)", () => {
  // SplitView swaps the connection overlay for a freshly mounted TerminalSlot
  // once the session connects; a Retry in the overlay marked the tab.
  it("focuses the terminal on mount after Retry when focus is on the body", () => {
    markTerminalRefocusPending(TAB);
    render();
    expect(focusTerminal).toHaveBeenCalledWith(TAB);
    expect(consumeTerminalRefocusPending(TAB)).toBe(false);
  });

  it("does not steal focus from a dialog on mount after Retry", () => {
    markTerminalRefocusPending(TAB);
    outside.focus();
    render();
    expect(focusTerminal).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(outside);
    // The mark is consumed either way, so a later activation focuses normally.
    expect(consumeTerminalRefocusPending(TAB)).toBe(false);
  });

  it("keeps focusing on plain activation (no pending reconnect)", () => {
    outside.focus();
    render();
    expect(focusTerminal).toHaveBeenCalledWith(TAB);
  });
});
