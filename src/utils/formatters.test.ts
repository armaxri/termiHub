import { describe, it, expect } from "vitest";
import { formatBytes, truncate, formatRelativeTime } from "./formatters";

describe("formatBytes", () => {
  it("formats 0 bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
  });

  it("formats bytes below 1 KB", () => {
    expect(formatBytes(512)).toBe("512 B");
  });

  it("formats exactly 1 KB", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
  });

  it("formats fractional KB", () => {
    expect(formatBytes(1536)).toBe("1.5 KB");
  });

  it("formats exactly 1 MB", () => {
    expect(formatBytes(1048576)).toBe("1.0 MB");
  });

  it("formats exactly 1 GB", () => {
    expect(formatBytes(1073741824)).toBe("1.0 GB");
  });
});

describe("truncate", () => {
  it("returns short string unchanged", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("truncates long string with ellipsis", () => {
    const result = truncate("hello world", 6);
    expect(result).toBe("hello\u2026");
    expect(result.length).toBe(6);
  });

  it("returns string at exact max length unchanged", () => {
    expect(truncate("hello", 5)).toBe("hello");
  });
});

describe("formatRelativeTime", () => {
  it("returns 'just now' for recent timestamps", () => {
    const now = new Date().toISOString();
    expect(formatRelativeTime(now)).toBe("just now");
  });
});
