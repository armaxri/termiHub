import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { applyTheme, getXtermTheme, getCurrentTheme, onThemeChange, dispose } from "./engine";
import { darkTheme } from "./dark";
import { lightTheme } from "./light";

/** Stub matchMedia so we can control the `prefers-color-scheme` value. */
function stubMatchMedia(prefersDark: boolean) {
  const listeners: Array<(e: { matches: boolean }) => void> = [];
  const mql = {
    matches: prefersDark,
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addEventListener: vi.fn((_: string, cb: (e: { matches: boolean }) => void) => {
      listeners.push(cb);
    }),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  };
  window.matchMedia = vi.fn().mockReturnValue(mql);
  return { mql, listeners };
}

let originalMatchMedia: typeof window.matchMedia;

beforeEach(() => {
  originalMatchMedia = window.matchMedia;
  dispose();
  document.documentElement.style.cssText = "";
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
  vi.restoreAllMocks();
});

describe("applyTheme", () => {
  it("defaults to dark theme when setting is undefined", () => {
    applyTheme(undefined);
    expect(getCurrentTheme().id).toBe("dark");
  });

  it("applies dark theme for 'dark' setting", () => {
    applyTheme("dark");
    expect(getCurrentTheme().id).toBe("dark");
    expect(document.documentElement.style.getPropertyValue("--bg-primary")).toBe(
      darkTheme.colors.bgPrimary
    );
  });

  it("applies light theme for 'light' setting", () => {
    applyTheme("light");
    expect(getCurrentTheme().id).toBe("light");
    expect(document.documentElement.style.getPropertyValue("--bg-primary")).toBe(
      lightTheme.colors.bgPrimary
    );
  });

  it("resolves system mode to dark when OS prefers dark", () => {
    stubMatchMedia(true);
    applyTheme("system");
    expect(getCurrentTheme().id).toBe("dark");
  });

  it("resolves system mode to light when OS prefers light", () => {
    stubMatchMedia(false);
    applyTheme("system");
    expect(getCurrentTheme().id).toBe("light");
  });

  it("registers a matchMedia listener in system mode", () => {
    const { mql } = stubMatchMedia(true);
    applyTheme("system");
    expect(mql.addEventListener).toHaveBeenCalledWith("change", expect.any(Function));
  });

  it("does not register a matchMedia listener in explicit mode", () => {
    const { mql } = stubMatchMedia(true);
    applyTheme("dark");
    expect(mql.addEventListener).not.toHaveBeenCalled();
  });
});

describe("getXtermTheme", () => {
  it("returns dark terminal colors by default", () => {
    applyTheme("dark");
    const xt = getXtermTheme();
    expect(xt.background).toBe(darkTheme.colors.terminalBg);
    expect(xt.foreground).toBe(darkTheme.colors.terminalFg);
    expect(xt.red).toBe(darkTheme.colors.ansiRed);
  });

  it("returns light terminal colors after switching to light", () => {
    applyTheme("light");
    const xt = getXtermTheme();
    expect(xt.background).toBe(lightTheme.colors.terminalBg);
    expect(xt.foreground).toBe(lightTheme.colors.terminalFg);
    expect(xt.red).toBe(lightTheme.colors.ansiRed);
  });

  it("contains all 16 ANSI color keys", () => {
    applyTheme("dark");
    const xt = getXtermTheme();
    const ansiKeys = [
      "black",
      "red",
      "green",
      "yellow",
      "blue",
      "magenta",
      "cyan",
      "white",
      "brightBlack",
      "brightRed",
      "brightGreen",
      "brightYellow",
      "brightBlue",
      "brightMagenta",
      "brightCyan",
      "brightWhite",
    ];
    for (const key of ansiKeys) {
      expect(xt).toHaveProperty(key);
    }
  });
});

describe("onThemeChange", () => {
  it("fires callbacks when OS theme changes in system mode", () => {
    const { listeners } = stubMatchMedia(true);
    applyTheme("system");

    const cb = vi.fn();
    onThemeChange(cb);

    // Simulate OS theme change
    listeners[0]({ matches: false });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(getCurrentTheme().id).toBe("light");
  });

  it("unsubscribe stops further callbacks", () => {
    const { listeners } = stubMatchMedia(true);
    applyTheme("system");

    const cb = vi.fn();
    const unsub = onThemeChange(cb);
    unsub();

    listeners[0]({ matches: false });
    expect(cb).not.toHaveBeenCalled();
  });
});

describe("dispose", () => {
  it("removes media listener and clears callbacks", () => {
    const { mql } = stubMatchMedia(true);
    applyTheme("system");

    const cb = vi.fn();
    onThemeChange(cb);

    dispose();
    expect(mql.removeEventListener).toHaveBeenCalled();
  });
});
