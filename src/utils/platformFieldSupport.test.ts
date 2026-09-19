import { describe, it, expect } from "vitest";
import { fieldPlatformLimitation } from "./platformFieldSupport";

describe("fieldPlatformLimitation", () => {
  it("flags RDP audio output as unavailable on Linux", () => {
    const note = fieldPlatformLimitation("audioRedirection", "linux");
    expect(note).not.toBeNull();
    expect(note).toContain("Not available on Linux");
  });

  it("reports no limitation for RDP audio on macOS or Windows", () => {
    expect(fieldPlatformLimitation("audioRedirection", "macos")).toBeNull();
    expect(fieldPlatformLimitation("audioRedirection", "windows")).toBeNull();
  });

  it("reports no limitation for unrelated fields on any platform", () => {
    expect(fieldPlatformLimitation("driveRedirection", "linux")).toBeNull();
    expect(fieldPlatformLimitation("host", "linux")).toBeNull();
    expect(fieldPlatformLimitation("audioRedirection".slice(0, -1), "linux")).toBeNull();
  });
});
