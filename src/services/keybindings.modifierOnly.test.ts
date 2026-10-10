import { describe, it, expect, afterEach } from "vitest";
import {
  RELEASE_CHORD_ACTION,
  checkConflict,
  clearOverrides,
  findMatchingAction,
  formatComboForDisplay,
  getEffectiveCombo,
  getOverrides,
  getReleaseChord,
  isModifierOnlyAction,
  isModifierOnlyCombo,
  isUnboundCombo,
  isValidModifierOnlyCombo,
  parseBinding,
  serializeBinding,
  setOverride,
  setOverrides,
  unbindAction,
} from "./keybindings";

const DEFAULT_CHORD = { key: "", ctrl: true, alt: true, shift: true };

describe("modifier-only combos (#4524)", () => {
  afterEach(() => clearOverrides());

  it("is not mistaken for the unbound sentinel", () => {
    expect(isUnboundCombo({ key: "", ctrl: true, alt: true })).toBe(false);
    expect(isUnboundCombo({ key: "" })).toBe(true);
  });

  it("classifies modifier-only and valid (two or more modifiers) chords", () => {
    expect(isModifierOnlyCombo({ key: "", shift: true })).toBe(true);
    expect(isModifierOnlyCombo({ key: "a", ctrl: true })).toBe(false);
    expect(isModifierOnlyCombo([{ key: "", ctrl: true, alt: true }])).toBe(false);
    expect(isValidModifierOnlyCombo({ key: "", shift: true })).toBe(false);
    expect(isValidModifierOnlyCombo({ key: "", ctrl: true, meta: true })).toBe(true);
    expect(isValidModifierOnlyCombo({ key: "" })).toBe(false);
  });

  it("serializes as just its modifiers and parses back", () => {
    const combo = { key: "", ctrl: true, alt: true };
    expect(serializeBinding(combo)).toBe("Ctrl+Alt");
    expect(parseBinding("Ctrl+Alt")).toEqual(combo);
    expect(serializeBinding({ key: "" })).toBe("");
  });

  it("displays without a trailing separator", () => {
    expect(formatComboForDisplay(DEFAULT_CHORD, false)).toBe("Ctrl+Shift+Alt");
    expect(formatComboForDisplay({ key: "", ctrl: true, meta: true }, true)).toBe("Cmd+Ctrl");
  });

  it("is never matched as an app shortcut", () => {
    const event = new KeyboardEvent("keydown", {
      key: "Shift",
      ctrlKey: true,
      altKey: true,
      shiftKey: true,
    });
    expect(findMatchingAction(event)).toBeNull();
  });

  it("does not conflict with key combos sharing its modifiers", () => {
    expect(checkConflict({ key: "X", ctrl: true, alt: true, shift: true })).toBeNull();
    expect(checkConflict(DEFAULT_CHORD)).toBe(RELEASE_CHORD_ACTION);
  });
});

describe("release chord binding (#4524)", () => {
  afterEach(() => clearOverrides());

  it("is a registered modifier-only action with a Ctrl+Alt+Shift default", () => {
    expect(isModifierOnlyAction(RELEASE_CHORD_ACTION)).toBe(true);
    expect(isModifierOnlyAction("toggle-sidebar")).toBe(false);
    expect(getEffectiveCombo(RELEASE_CHORD_ACTION)).toEqual(DEFAULT_CHORD);
    expect(getReleaseChord()).toEqual(DEFAULT_CHORD);
  });

  it("round-trips a rebound chord through persisted overrides", () => {
    setOverride(RELEASE_CHORD_ACTION, { key: "", ctrl: true, shift: true, meta: true });
    const persisted = getOverrides();
    expect(persisted).toEqual([{ action: RELEASE_CHORD_ACTION, key: "Ctrl+Shift+Cmd" }]);

    clearOverrides();
    setOverrides(JSON.parse(JSON.stringify(persisted)));
    expect(getReleaseChord()).toEqual({ key: "", ctrl: true, shift: true, meta: true });
    expect(getOverrides()).toEqual(persisted);
  });

  it("refuses to unbind it: unbinding resets to the default", () => {
    setOverride(RELEASE_CHORD_ACTION, { key: "", ctrl: true, alt: true });
    unbindAction(RELEASE_CHORD_ACTION);
    expect(getOverrides()).toEqual([]);
    expect(getReleaseChord()).toEqual(DEFAULT_CHORD);
  });

  it("drops unusable overrides on load and on set", () => {
    setOverrides([
      { action: RELEASE_CHORD_ACTION, key: "Shift" },
      { action: "toggle-sidebar", key: "Ctrl+Alt+b" },
    ]);
    expect(getOverrides()).toEqual([{ action: "toggle-sidebar", key: "Ctrl+Alt+b" }]);

    for (const bad of ["", "Alt", "Ctrl+Alt+x", "Ctrl+k Ctrl+j"]) {
      setOverrides([{ action: RELEASE_CHORD_ACTION, key: bad }]);
      expect(getReleaseChord()).toEqual(DEFAULT_CHORD);
    }

    setOverride(RELEASE_CHORD_ACTION, { key: "", meta: true });
    expect(getReleaseChord()).toEqual(DEFAULT_CHORD);
  });
});
