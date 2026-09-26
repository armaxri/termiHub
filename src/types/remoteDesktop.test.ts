import { describe, it, expect } from "vitest";
import { effectiveScaleMode, isFixedResolution, scaleModesFor } from "./remoteDesktop";

describe("remote-desktop resolution helpers (PROD-026)", () => {
  it("treats only resolutionMode 'fixed' as a fixed resolution", () => {
    expect(isFixedResolution({ resolutionMode: "fixed" })).toBe(true);
    expect(isFixedResolution({ resolutionMode: " Fixed " })).toBe(true);
    expect(isFixedResolution({ resolutionMode: "dynamic" })).toBe(false);
    // A connection saved before the option existed is dynamic.
    expect(isFixedResolution({ host: "h" })).toBe(false);
    expect(isFixedResolution({ resolutionMode: 1 })).toBe(false);
  });

  it("offers Match Window only to dynamic sessions", () => {
    expect(scaleModesFor(false)).toEqual(["fit", "pixel", "match"]);
    expect(scaleModesFor(true)).toEqual(["fit", "pixel"]);
  });

  it("falls back from Match Window to Fit for a fixed session", () => {
    expect(effectiveScaleMode("match", true)).toBe("fit");
    expect(effectiveScaleMode("pixel", true)).toBe("pixel");
    expect(effectiveScaleMode("match", false)).toBe("match");
  });
});
