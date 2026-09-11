import { describe, it, expect } from "vitest";
import { formatBytes, formatAbsoluteTime } from "./formatters";

describe("formatBytes", () => {
  it("formats real byte counts", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3.0 GB");
  });

  it("returns an empty string for a missing or invalid size (no 'NaN GB') (#2798)", () => {
    expect(formatBytes(undefined)).toBe("");
    expect(formatBytes(null)).toBe("");
    expect(formatBytes(NaN)).toBe("");
    expect(formatBytes(Infinity)).toBe("");
    expect(formatBytes(-1)).toBe("");
  });
});

describe("formatAbsoluteTime", () => {
  it("formats a valid timestamp to a localized string carrying the full year", () => {
    const out = formatAbsoluteTime("2026-01-15T10:30:00Z");
    expect(out).not.toBe("");
    expect(out).toContain("2026");
  });

  it("returns an empty string for a missing or unparseable input", () => {
    expect(formatAbsoluteTime(undefined)).toBe("");
    expect(formatAbsoluteTime(null)).toBe("");
    expect(formatAbsoluteTime("")).toBe("");
    expect(formatAbsoluteTime("not a date")).toBe("");
  });
});
