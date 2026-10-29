/**
 * Alternate default bindings (#5084): an action may ship more than one default
 * combo on a platform. On macOS the command palette opens with Cmd+P and with
 * Cmd+Shift+P (the VS Code habit).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  DEFAULT_BINDINGS,
  checkConflict,
  clearOverrides,
  findMatchingAction,
  formatActionBindings,
  getEffectiveAlternates,
  serializeCombo,
  setOverride,
  unbindAction,
} from "./keybindings";
import type { KeyCombo } from "@/types/keybindings";

const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15";
const LINUX_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36";

const CMD_SHIFT_P: KeyCombo = { key: "P", meta: true, shift: true };

function keydown(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
}

function useUserAgent(ua: string) {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua);
}

beforeEach(() => clearOverrides());
afterEach(() => {
  clearOverrides();
  vi.restoreAllMocks();
});

describe("command palette alternate default on macOS (#5084)", () => {
  beforeEach(() => useUserAgent(MAC_UA));

  it("keeps Cmd+P as the primary binding", () => {
    expect(findMatchingAction(keydown({ key: "p", code: "KeyP", metaKey: true }))).toBe(
      "command-palette"
    );
  });

  it("resolves Cmd+Shift+P to the command palette", () => {
    expect(
      findMatchingAction(keydown({ key: "P", code: "KeyP", metaKey: true, shiftKey: true }))
    ).toBe("command-palette");
  });

  it("resolves Cmd+Shift+P on a German layout (physical KeyP)", () => {
    // German QWERTZ: the P key still reports code KeyP and key "P" with Shift.
    expect(
      findMatchingAction(keydown({ key: "P", code: "KeyP", metaKey: true, shiftKey: true }))
    ).toBe("command-palette");
    // Without a code (synthetic events) the character still matches.
    expect(findMatchingAction(keydown({ key: "P", metaKey: true, shiftKey: true }))).toBe(
      "command-palette"
    );
  });

  it("exposes the alternate and formats both for display", () => {
    expect(getEffectiveAlternates("command-palette")).toEqual([CMD_SHIFT_P]);
    expect(formatActionBindings("command-palette")).toBe("Cmd+P / Cmd+Shift+P");
  });

  it("reports the alternate as a conflict when another action records it", () => {
    expect(checkConflict(CMD_SHIFT_P, "toggle-sidebar")).toBe("command-palette");
    expect(checkConflict(CMD_SHIFT_P, "command-palette")).toBeNull();
  });

  it("no other macOS default uses Cmd+Shift+P", () => {
    const clash = DEFAULT_BINDINGS.filter((b) => b.action !== "command-palette").find((b) =>
      [b.macDefault, ...(b.macAlternates ?? [])].some(
        (c) => c && !Array.isArray(c) && serializeCombo(c) === serializeCombo(CMD_SHIFT_P)
      )
    );
    expect(clash?.action).toBeUndefined();
  });

  it("a user override replaces both defaults, removing the alternate", () => {
    setOverride("command-palette", { key: "p", meta: true });
    expect(getEffectiveAlternates("command-palette")).toEqual([]);
    expect(
      findMatchingAction(keydown({ key: "P", code: "KeyP", metaKey: true, shiftKey: true }))
    ).toBeNull();
    expect(formatActionBindings("command-palette")).toBe("Cmd+P");
    // Freed: another action may now take Cmd+Shift+P without a conflict.
    expect(checkConflict(CMD_SHIFT_P, "toggle-sidebar")).toBeNull();
  });

  it("unbinding the action disables the alternate too", () => {
    unbindAction("command-palette");
    expect(
      findMatchingAction(keydown({ key: "P", code: "KeyP", metaKey: true, shiftKey: true }))
    ).toBeNull();
    expect(formatActionBindings("command-palette")).toBeNull();
  });

  it("resetting to default restores the alternate", () => {
    unbindAction("command-palette");
    setOverride("command-palette", null);
    expect(getEffectiveAlternates("command-palette")).toEqual([CMD_SHIFT_P]);
  });
});

describe("command palette alternates on Windows/Linux (#5084)", () => {
  beforeEach(() => useUserAgent(LINUX_UA));

  it("adds no alternate: Ctrl+Shift+P stays the only default", () => {
    expect(getEffectiveAlternates("command-palette")).toEqual([]);
    expect(formatActionBindings("command-palette")).toBe("Ctrl+Shift+P");
    expect(
      findMatchingAction(keydown({ key: "P", code: "KeyP", metaKey: true, shiftKey: true }))
    ).toBeNull();
  });
});
