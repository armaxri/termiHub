/**
 * F6 region cycling vs. a focused terminal (#4773), against the real
 * keybinding service: bare F6 / Shift+F6 reach the running program, while the
 * Ctrl+F6 variants are kept from the PTY so the app can cycle focus.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { routeTerminalKeyEvent, type TerminalKeyRoutingContext } from "./terminalInputRouting";
import { cancelChord, clearOverrides, setOverride } from "@/services/keybindings";

function ctx(): TerminalKeyRoutingContext {
  return {
    hasSession: true,
    isViewMode: false,
    passthroughEnabled: true,
    hasCommandMarks: vi.fn(() => false),
    showReconnectPrompt: vi.fn(),
    copySelection: vi.fn(),
    paste: vi.fn(),
    selectAll: vi.fn(),
  };
}

function key(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", { key: "F6", bubbles: true, cancelable: true, ...init });
}

describe("terminal routing of the region-cycle keys (Linux/Win context)", () => {
  beforeEach(() => {
    clearOverrides();
    cancelChord();
  });

  it("passes F6 and Shift+F6 through to the terminal program", () => {
    expect(routeTerminalKeyEvent(key({}), ctx())).toBe(true);
    expect(routeTerminalKeyEvent(key({ shiftKey: true }), ctx())).toBe(true);
  });

  it("keeps Ctrl+F6 and Ctrl+Shift+F6 from the terminal program", () => {
    expect(routeTerminalKeyEvent(key({ ctrlKey: true }), ctx())).toBe(false);
    expect(routeTerminalKeyEvent(key({ ctrlKey: true, shiftKey: true }), ctx())).toBe(false);
  });

  it("follows a rebind of the terminal-yielding action", () => {
    setOverride("focus-next-region", { key: "F7" });
    expect(routeTerminalKeyEvent(key({ key: "F7" }), ctx())).toBe(true);
  });
});
