/**
 * Shortcut hints in tooltips/labels come from the keybinding service (#4374,
 * WA-FE2-003): they show the effective binding for the current platform —
 * including a user override — and drop the hint when the action is unbound.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  clearOverrides,
  formatBindingForDisplay,
  formatComboForDisplay,
  getActionAccelerator,
  getOverrides,
  modKeyAccelerator,
  setOverrides,
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
      "New Tab Group (Cmd+Shift+T)"
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

describe("display formatting (#4598)", () => {
  const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)";
  const WIN_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
  const LINUX_UA = "Mozilla/5.0 (X11; Linux x86_64)";

  it("getActionAccelerator('toggle-sidebar') is Cmd+B on macOS", () => {
    setUserAgent(MAC_UA);
    expect(getActionAccelerator("toggle-sidebar")).toBe("Cmd+B");
  });

  it("getActionAccelerator('toggle-sidebar') is Ctrl+Shift+B on Windows and Linux", () => {
    // The Win/Linux default avoids the tmux prefix Ctrl+B (see DEFAULT_BINDINGS).
    setUserAgent(WIN_UA);
    expect(getActionAccelerator("toggle-sidebar")).toBe("Ctrl+Shift+B");
    setUserAgent(LINUX_UA);
    expect(getActionAccelerator("toggle-sidebar")).toBe("Ctrl+Shift+B");
  });

  it("New Tab Group renders primary modifier first per platform", () => {
    setUserAgent(MAC_UA);
    expect(getActionAccelerator("new-tab-group")).toBe("Cmd+Shift+T");
    setUserAgent(WIN_UA);
    expect(getActionAccelerator("new-tab-group")).toBe("Ctrl+Shift+T");
  });

  it("upper-cases a lower-case override letter on display", () => {
    setUserAgent(LINUX_UA);
    setOverrides([{ action: "toggle-sidebar", key: "Ctrl+Alt+b" }]);
    expect(getActionAccelerator("toggle-sidebar")).toBe("Ctrl+Alt+B");
  });

  it("orders modifiers in the platform convention", () => {
    const combo = { key: "x", ctrl: true, shift: true, alt: true, meta: true };
    expect(formatComboForDisplay(combo, true)).toBe("Cmd+Ctrl+Shift+Alt+X");
    expect(formatComboForDisplay(combo, false)).toBe("Ctrl+Shift+Alt+Cmd+X");
  });

  it("leaves named keys and symbols alone", () => {
    expect(formatComboForDisplay({ key: "F1" }, false)).toBe("F1");
    expect(formatComboForDisplay({ key: "ArrowUp", ctrl: true }, false)).toBe("Ctrl+Up");
    expect(formatComboForDisplay({ key: " ", ctrl: true }, false)).toBe("Ctrl+Space");
    expect(formatComboForDisplay({ key: ",", meta: true }, true)).toBe("Cmd+,");
  });

  it("formats chords space-separated", () => {
    expect(
      formatBindingForDisplay(
        [
          { key: "k", meta: true },
          { key: "s", meta: true },
        ],
        true
      )
    ).toBe("Cmd+K Cmd+S");
  });

  it("does not change the stored override string (byte-identical round-trip)", () => {
    setUserAgent(MAC_UA);
    const stored = [
      { action: "toggle-sidebar", key: "Shift+Cmd+b" },
      { action: "new-terminal", key: "Ctrl+k Ctrl+j" },
    ];
    setOverrides(stored);
    // Rendering must not leak into persistence.
    expect(getActionAccelerator("toggle-sidebar")).toBe("Cmd+Shift+B");
    expect(getOverrides()).toEqual(stored);
    expect(JSON.stringify(getOverrides())).toBe(JSON.stringify(stored));
  });
});
