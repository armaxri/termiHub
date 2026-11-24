import { describe, it, expect, afterEach } from "vitest";
import {
  isPlainFunctionKey,
  recordedKeyFromEvent,
  takesKeyFromTerminalPrograms,
  terminalKeyRejectionText,
  type RecorderKeyEvent,
} from "./keybindingRecorder";
import {
  clearOverrides,
  getEffectiveCombo,
  isUnboundCombo,
  releaseBindingFrom,
  setOverride,
} from "@/services/keybindings";

function ev(partial: Partial<RecorderKeyEvent>): RecorderKeyEvent {
  return {
    key: "",
    code: "",
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...partial,
  };
}

describe("recordedKeyFromEvent (#5842)", () => {
  it("records a plain combo as reported", () => {
    expect(recordedKeyFromEvent(ev({ key: "b", code: "KeyB", ctrlKey: true }))).toEqual({
      kind: "combo",
      combo: { key: "b", ctrl: true },
    });
  });

  it("ignores lone modifiers, AltGr and IME composition", () => {
    expect(recordedKeyFromEvent(ev({ key: "Shift", code: "ShiftLeft" })).kind).toBe("ignore");
    expect(recordedKeyFromEvent(ev({ key: "AltGraph", code: "AltRight" })).kind).toBe("ignore");
    expect(recordedKeyFromEvent(ev({ key: "Process", code: "KeyA" })).kind).toBe("ignore");
    expect(recordedKeyFromEvent(ev({ key: "a", code: "KeyA", isComposing: true })).kind).toBe(
      "ignore"
    );
  });

  it("stores the physical letter for an Option character on a German Mac (Option+L = @)", () => {
    expect(
      recordedKeyFromEvent(ev({ key: "@", code: "KeyL", altKey: true, metaKey: true }))
    ).toEqual({ kind: "combo", combo: { key: "l", alt: true, meta: true } });
  });

  it("stores the physical letter for an AltGr character (Ctrl+Alt+Q = @ on Windows)", () => {
    expect(
      recordedKeyFromEvent(ev({ key: "@", code: "KeyQ", ctrlKey: true, altKey: true }))
    ).toEqual({ kind: "combo", combo: { key: "q", ctrl: true, alt: true } });
  });

  it("maps a dead key on a letter (Option+N starts ~) to that letter", () => {
    expect(recordedKeyFromEvent(ev({ key: "Dead", code: "KeyN", altKey: true }))).toEqual({
      kind: "combo",
      combo: { key: "n", alt: true },
    });
  });

  it("refuses a dead key that is not on a letter or digit (´ ` ^)", () => {
    expect(recordedKeyFromEvent(ev({ key: "Dead", code: "Equal" })).kind).toBe("dead-key");
    expect(recordedKeyFromEvent(ev({ key: "Dead", code: "Backquote", ctrlKey: true })).kind).toBe(
      "dead-key"
    );
  });

  it("keeps an umlaut key's own character", () => {
    expect(recordedKeyFromEvent(ev({ key: "ö", code: "Semicolon", ctrlKey: true }))).toEqual({
      kind: "combo",
      combo: { key: "ö", ctrl: true },
    });
  });

  it("keeps Shift's uppercase letter for a physical-key mapping", () => {
    expect(
      recordedKeyFromEvent(ev({ key: "Ø", code: "KeyO", altKey: true, shiftKey: true }))
    ).toEqual({ kind: "combo", combo: { key: "O", alt: true, shift: true } });
  });
});

describe("plain function keys and terminal programs (#4773, #5842)", () => {
  it("treats F1–F24 without Ctrl/Alt/Cmd as plain, Shift included", () => {
    expect(isPlainFunctionKey({ key: "F5" })).toBe(true);
    expect(isPlainFunctionKey({ key: "F6", shift: true })).toBe(true);
    expect(isPlainFunctionKey({ key: "F12", ctrl: true })).toBe(false);
    expect(isPlainFunctionKey({ key: "F1", meta: true })).toBe(false);
    expect(isPlainFunctionKey({ key: "f" })).toBe(false);
  });

  it("refuses a plain function key for a global action", () => {
    expect(takesKeyFromTerminalPrograms("toggle-sidebar", { key: "F5" })).toBe(true);
    expect(takesKeyFromTerminalPrograms("toggle-sidebar", { key: "F5", ctrl: true })).toBe(false);
  });

  it("allows a plain function key for an action that yields to a focused terminal", () => {
    expect(takesKeyFromTerminalPrograms("focus-next-region", { key: "F7" })).toBe(false);
  });

  it("checks a chord's first combo", () => {
    expect(takesKeyFromTerminalPrograms("toggle-sidebar", [{ key: "F2" }, { key: "s" }])).toBe(
      true
    );
  });

  it("says what to press instead", () => {
    const text = terminalKeyRejectionText("Toggle sidebar", { key: "F5" });
    expect(text).toContain("F5");
    expect(text).toContain("Add Ctrl, Alt or Cmd");
    expect(text).toContain("Toggle sidebar shortcut unchanged.");
  });
});

describe("releaseBindingFrom (#5842)", () => {
  afterEach(() => clearOverrides());

  it("unbinds an action whose only binding is taken", () => {
    setOverride("toggle-sidebar", { key: "F9", ctrl: true });
    releaseBindingFrom("toggle-sidebar", { key: "F9", ctrl: true });
    expect(isUnboundCombo(getEffectiveCombo("toggle-sidebar"))).toBe(true);
  });

  it("leaves an action alone when the candidate does not collide", () => {
    setOverride("toggle-sidebar", { key: "F9", ctrl: true });
    releaseBindingFrom("toggle-sidebar", { key: "F8", ctrl: true });
    expect(getEffectiveCombo("toggle-sidebar")).toEqual({ key: "F9", ctrl: true });
  });
});
