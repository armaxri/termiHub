/**
 * Terminal focus does not swallow the command-palette shortcuts (#5084).
 *
 * Runs `routeTerminalKeyEvent` against the real keybinding service (the sibling
 * `terminalInputRouting.test.ts` mocks it), so both macOS defaults are pinned:
 * xterm must not consume Cmd+P / Cmd+Shift+P, leaving them to the global
 * shortcut handler that opens the palette.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { clearOverrides } from "@/services/keybindings";
import { routeTerminalKeyEvent, type TerminalKeyRoutingContext } from "./terminalInputRouting";

const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15";

function context(): TerminalKeyRoutingContext {
  return {
    hasSession: true,
    isViewMode: false,
    passthroughEnabled: true,
    hasCommandMarks: () => false,
    showReconnectPrompt: vi.fn(),
    copySelection: vi.fn(),
    paste: vi.fn(),
    selectAll: vi.fn(),
  };
}

beforeEach(() => {
  clearOverrides();
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(MAC_UA);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("routeTerminalKeyEvent — command palette on macOS (#5084)", () => {
  it.each([
    ["Cmd+P", { key: "p", code: "KeyP", metaKey: true }],
    ["Cmd+Shift+P", { key: "P", code: "KeyP", metaKey: true, shiftKey: true }],
  ])("keeps %s away from the PTY", (_name, init) => {
    const event = new KeyboardEvent("keydown", { cancelable: true, ...init });
    expect(routeTerminalKeyEvent(event, context())).toBe(false);
  });

  it("still lets plain Shift+P reach the PTY", () => {
    const event = new KeyboardEvent("keydown", { key: "P", code: "KeyP", shiftKey: true });
    expect(routeTerminalKeyEvent(event, context())).toBe(true);
  });
});
