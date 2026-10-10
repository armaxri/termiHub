import { describe, it, expect, afterEach } from "vitest";
import { isReleaseChord, releaseChordLabel } from "./releaseChord";
import {
  RELEASE_CHORD_ACTION,
  clearOverrides,
  getOverrides,
  getReleaseChord,
  setOverride,
  setOverrides,
  unbindAction,
} from "@/services/keybindings";

/** A modifier-state snapshot, defaulting every modifier to released. */
function mods(m: Partial<Record<"ctrlKey" | "altKey" | "shiftKey" | "metaKey", boolean>>) {
  return { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...m };
}

describe("releaseChord (#4328, #4524)", () => {
  afterEach(() => clearOverrides());

  it("labels the default chord through the shared display formatter", () => {
    expect(releaseChordLabel(false)).toBe("Ctrl+Shift+Alt");
    expect(releaseChordLabel(true)).toBe("Ctrl+Shift+Alt");
  });

  it("matches the default chord only when Ctrl, Alt and Shift are all held", () => {
    expect(isReleaseChord(mods({ ctrlKey: true, altKey: true, shiftKey: true }))).toBe(true);
    expect(isReleaseChord(mods({ ctrlKey: true, altKey: true }))).toBe(false);
    expect(isReleaseChord(mods({ altKey: true, shiftKey: true }))).toBe(false);
    expect(isReleaseChord(mods({ ctrlKey: true, shiftKey: true }))).toBe(false);
  });

  it("still releases when an extra modifier is held, so the escape stays reachable", () => {
    expect(
      isReleaseChord(mods({ ctrlKey: true, altKey: true, shiftKey: true, metaKey: true }))
    ).toBe(true);
  });

  it("follows a rebound modifier-only chord", () => {
    setOverride(RELEASE_CHORD_ACTION, { key: "", ctrl: true, meta: true });
    expect(isReleaseChord(mods({ ctrlKey: true, metaKey: true }))).toBe(true);
    expect(isReleaseChord(mods({ ctrlKey: true, altKey: true, shiftKey: true }))).toBe(false);
    expect(releaseChordLabel(true)).toBe("Cmd+Ctrl");
    expect(releaseChordLabel(false)).toBe("Ctrl+Cmd");
  });

  it("falls back to the default when the override is unbound", () => {
    unbindAction(RELEASE_CHORD_ACTION);
    expect(isReleaseChord(mods({ ctrlKey: true, altKey: true, shiftKey: true }))).toBe(true);
  });

  it("falls back to the default when a persisted override names a single modifier", () => {
    setOverrides([{ action: RELEASE_CHORD_ACTION, key: "Shift" }]);
    expect(isReleaseChord(mods({ shiftKey: true }))).toBe(false);
    expect(isReleaseChord(mods({ ctrlKey: true, altKey: true, shiftKey: true }))).toBe(true);
  });

  it("falls back to the default when a persisted override carries a non-modifier key", () => {
    setOverrides([{ action: RELEASE_CHORD_ACTION, key: "Ctrl+Alt+x" }]);
    expect(getReleaseChord()).toEqual({ key: "", ctrl: true, alt: true, shift: true });
  });

  it("round-trips a modifier-only override through persistence", () => {
    setOverride(RELEASE_CHORD_ACTION, { key: "", ctrl: true, alt: true });
    const persisted = getOverrides();
    expect(persisted).toEqual([{ action: RELEASE_CHORD_ACTION, key: "Ctrl+Alt" }]);

    clearOverrides();
    setOverrides(persisted);
    expect(getReleaseChord()).toEqual({ key: "", ctrl: true, alt: true });
    expect(isReleaseChord(mods({ ctrlKey: true, altKey: true }))).toBe(true);
  });
});
