import { describe, it, expect } from "vitest";
import { isReleaseChord, releaseChordLabel } from "./releaseChord";

describe("releaseChord (#4328)", () => {
  it("labels the chord per platform", () => {
    expect(releaseChordLabel("windows")).toBe("Ctrl+Alt+Shift");
    expect(releaseChordLabel("linux")).toBe("Ctrl+Alt+Shift");
    expect(releaseChordLabel("macos")).toBe("Ctrl+Option+Shift");
  });

  it("matches only when Ctrl, Alt and Shift are all held", () => {
    expect(isReleaseChord({ ctrlKey: true, altKey: true, shiftKey: true })).toBe(true);
    expect(isReleaseChord({ ctrlKey: true, altKey: true, shiftKey: false })).toBe(false);
    expect(isReleaseChord({ ctrlKey: false, altKey: true, shiftKey: true })).toBe(false);
    expect(isReleaseChord({ ctrlKey: true, altKey: false, shiftKey: true })).toBe(false);
  });
});
