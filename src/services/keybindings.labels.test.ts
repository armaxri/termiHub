/**
 * Shortcut hints in tooltips/labels come from the keybinding service (#4374,
 * WA-FE2-003): they show the effective binding for the current platform —
 * including a user override — and drop the hint when the action is unbound.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  clearOverrides,
  modKeyAccelerator,
  setOverride,
  unbindAction,
  withActionAccelerator,
} from "./keybindings";

const originalUserAgent = Object.getOwnPropertyDescriptor(window.navigator, "userAgent");

function setUserAgent(ua: string): void {
  Object.defineProperty(window.navigator, "userAgent", { configurable: true, get: () => ua });
}

afterEach(() => {
  clearOverrides();
  if (originalUserAgent) Object.defineProperty(window.navigator, "userAgent", originalUserAgent);
  else delete (window.navigator as { userAgent?: string }).userAgent;
});

describe("withActionAccelerator", () => {
  it("shows the Win/Linux default (Ctrl+Shift+B, not the tmux prefix Ctrl+B)", () => {
    setUserAgent("Mozilla/5.0 (X11; Linux x86_64)");
    expect(withActionAccelerator("Toggle Sidebar", "toggle-sidebar")).toBe(
      "Toggle Sidebar (Ctrl+Shift+B)"
    );
  });

  it("shows the macOS default with Cmd", () => {
    setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
    expect(withActionAccelerator("New Tab Group", "new-tab-group")).toBe(
      "New Tab Group (Shift+Cmd+t)"
    );
  });

  it("reflects a user override", () => {
    setOverride("toggle-sidebar", { key: "F9" });
    expect(withActionAccelerator("Toggle Sidebar", "toggle-sidebar")).toBe("Toggle Sidebar (F9)");
  });

  it("omits the hint when the action is unbound or unknown", () => {
    unbindAction("toggle-sidebar");
    expect(withActionAccelerator("Toggle Sidebar", "toggle-sidebar")).toBe("Toggle Sidebar");
    expect(withActionAccelerator("Nothing", "no-such-action")).toBe("Nothing");
  });
});

describe("modKeyAccelerator", () => {
  it("uses Cmd on macOS and Ctrl elsewhere", () => {
    setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
    expect(modKeyAccelerator("S")).toBe("Cmd+S");
    setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
    expect(modKeyAccelerator("S")).toBe("Ctrl+S");
  });
});
