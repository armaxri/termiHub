import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isCopyShortcut, isPasteShortcut, isSelectAllShortcut } from "./keybindingHelpers";

/** Create a synthetic KeyboardEvent with specified modifier flags. */
function makeKeyEvent(
  key: string,
  mods: { ctrl?: boolean; shift?: boolean; meta?: boolean; alt?: boolean } = {}
): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    key,
    ctrlKey: mods.ctrl ?? false,
    shiftKey: mods.shift ?? false,
    metaKey: mods.meta ?? false,
    altKey: mods.alt ?? false,
  });
}

describe("keybinding helpers (non-macOS / Linux)", () => {
  // jsdom default user agent doesn't include "Macintosh", so isMac() returns false

  describe("isCopyShortcut", () => {
    it("matches Ctrl+Shift+C", () => {
      expect(isCopyShortcut(makeKeyEvent("C", { ctrl: true, shift: true }))).toBe(true);
    });

    it("does not match Ctrl+C (no shift)", () => {
      expect(isCopyShortcut(makeKeyEvent("c", { ctrl: true }))).toBe(false);
    });

    it("does not match Cmd+C on non-mac", () => {
      expect(isCopyShortcut(makeKeyEvent("c", { meta: true }))).toBe(false);
    });

    it("does not match with extra alt modifier", () => {
      expect(isCopyShortcut(makeKeyEvent("C", { ctrl: true, shift: true, alt: true }))).toBe(false);
    });
  });

  describe("isPasteShortcut", () => {
    it("matches Ctrl+Shift+V", () => {
      expect(isPasteShortcut(makeKeyEvent("V", { ctrl: true, shift: true }))).toBe(true);
    });

    it("does not match Ctrl+V (no shift)", () => {
      expect(isPasteShortcut(makeKeyEvent("v", { ctrl: true }))).toBe(false);
    });

    it("does not match Cmd+V on non-mac", () => {
      expect(isPasteShortcut(makeKeyEvent("v", { meta: true }))).toBe(false);
    });
  });

  describe("isSelectAllShortcut", () => {
    it("matches Ctrl+Shift+A", () => {
      expect(isSelectAllShortcut(makeKeyEvent("A", { ctrl: true, shift: true }))).toBe(true);
    });

    it("does not match Ctrl+A (no shift)", () => {
      expect(isSelectAllShortcut(makeKeyEvent("a", { ctrl: true }))).toBe(false);
    });
  });
});

describe("keybinding helpers (macOS)", () => {
  let originalAgent: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalAgent = Object.getOwnPropertyDescriptor(navigator, "userAgent");
    Object.defineProperty(navigator, "userAgent", {
      value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
      configurable: true,
    });
  });

  afterEach(() => {
    if (originalAgent) {
      Object.defineProperty(navigator, "userAgent", originalAgent);
    } else {
      Object.defineProperty(navigator, "userAgent", {
        value: "Mozilla/5.0 (jsdom)",
        configurable: true,
      });
    }
  });

  describe("isCopyShortcut", () => {
    it("matches Cmd+C", () => {
      expect(isCopyShortcut(makeKeyEvent("c", { meta: true }))).toBe(true);
    });

    it("does not match Ctrl+C", () => {
      expect(isCopyShortcut(makeKeyEvent("c", { ctrl: true }))).toBe(false);
    });

    it("does not match Cmd+Shift+C", () => {
      expect(isCopyShortcut(makeKeyEvent("C", { meta: true, shift: true }))).toBe(false);
    });
  });

  describe("isPasteShortcut", () => {
    it("matches Cmd+V", () => {
      expect(isPasteShortcut(makeKeyEvent("v", { meta: true }))).toBe(true);
    });

    it("does not match Ctrl+V", () => {
      expect(isPasteShortcut(makeKeyEvent("v", { ctrl: true }))).toBe(false);
    });

    it("does not match Cmd+Shift+V", () => {
      expect(isPasteShortcut(makeKeyEvent("V", { meta: true, shift: true }))).toBe(false);
    });
  });

  describe("isSelectAllShortcut", () => {
    it("matches Cmd+A", () => {
      expect(isSelectAllShortcut(makeKeyEvent("a", { meta: true }))).toBe(true);
    });

    it("does not match Ctrl+A", () => {
      expect(isSelectAllShortcut(makeKeyEvent("a", { ctrl: true }))).toBe(false);
    });
  });
});
