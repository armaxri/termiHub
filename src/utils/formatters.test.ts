import { afterEach, describe, it, expect, vi } from "vitest";
import {
  formatBytes,
  formatRate,
  formatElapsed,
  formatRelativeAgo,
  formatRelativeTime,
  formatAbsoluteTime,
} from "./formatters";
import * as locale from "./locale";

describe("formatBytes", () => {
  it("formats real byte counts", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3.0 GB");
  });

  it("caps at the requested max unit", () => {
    // maxUnit "MB" never scales up to GB — a 3 GiB value stays in MB.
    expect(formatBytes(3 * 1024 * 1024 * 1024, { maxUnit: "MB" })).toBe("3,072.0 MB");
    expect(formatBytes(512, { maxUnit: "MB" })).toBe("512 B");
    expect(formatBytes(1536, { maxUnit: "MB" })).toBe("1.5 KB");
  });

  it("applies locale digit grouping to the numeric part (I18N-015)", () => {
    // Just under 1 MiB scales to ~1024 KB, which crosses the grouping threshold:
    // en-US groups thousands with a comma.
    expect(formatBytes(1000 * 1024)).toBe("1,000.0 KB");
  });

  it("returns an empty string for a missing or invalid size (no 'NaN GB') (#2798)", () => {
    expect(formatBytes(undefined)).toBe("");
    expect(formatBytes(null)).toBe("");
    expect(formatBytes(NaN)).toBe("");
    expect(formatBytes(Infinity)).toBe("");
    expect(formatBytes(-1)).toBe("");
  });
});

describe("formatRate", () => {
  it("formats bytes/sec into compact units, dropping trailing zeros", () => {
    expect(formatRate(512)).toBe("512 B/s");
    expect(formatRate(1024)).toBe("1 KB/s");
    expect(formatRate(23 * 1024)).toBe("23 KB/s");
    expect(formatRate(1536)).toBe("1.5 KB/s");
    expect(formatRate(2 * 1024 * 1024)).toBe("2 MB/s");
    // >= 100 in a scaled unit rounds to a whole number.
    expect(formatRate(112 * 1024)).toBe("112 KB/s");
  });

  it("returns an empty string for a missing or non-positive rate", () => {
    expect(formatRate(null)).toBe("");
    expect(formatRate(undefined)).toBe("");
    expect(formatRate(0)).toBe("");
    expect(formatRate(-5)).toBe("");
    expect(formatRate(NaN)).toBe("");
  });
});

describe("formatElapsed", () => {
  it("formats whole seconds as a compact readout", () => {
    expect(formatElapsed(5)).toBe("5s");
    expect(formatElapsed(59)).toBe("59s");
    expect(formatElapsed(65)).toBe("1m 05s");
    expect(formatElapsed(600)).toBe("10m 00s");
  });
});

describe("formatRelativeAgo", () => {
  it("uses minute resolution by default", () => {
    expect(formatRelativeAgo(30_000)).toBe("just now");
    expect(formatRelativeAgo(5 * 60_000)).toBe("5m ago");
    expect(formatRelativeAgo(2 * 3_600_000)).toBe("2h ago");
    expect(formatRelativeAgo(25 * 3_600_000)).toBe("1d ago");
  });

  it("adds second resolution when requested", () => {
    expect(formatRelativeAgo(500, { seconds: true })).toBe("just now");
    expect(formatRelativeAgo(5_000, { seconds: true })).toBe("5s ago");
    expect(formatRelativeAgo(3 * 60_000, { seconds: true })).toBe("3m ago");
  });

  it("clamps negative spans (clock skew) to 'just now'", () => {
    expect(formatRelativeAgo(-5_000)).toBe("just now");
    expect(formatRelativeAgo(-5_000, { seconds: true })).toBe("just now");
  });
});

describe("formatRelativeTime", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("shows a compact relative label for recent times", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
    expect(formatRelativeTime("2026-01-15T11:55:00Z")).toBe("5m ago");
    expect(formatRelativeTime("2026-01-13T12:00:00Z")).toBe("2d ago");
  });

  it("falls back to a locale-formatted absolute date beyond a week", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
    const out = formatRelativeTime("2026-01-01T12:00:00Z");
    expect(out).not.toContain("ago");
    expect(out).toContain("2026");
  });
});

describe("locale safety (C/POSIX guard, #2646)", () => {
  const originalLanguage = Object.getOwnPropertyDescriptor(navigator, "language");
  const originalLanguages = Object.getOwnPropertyDescriptor(navigator, "languages");

  afterEach(() => {
    if (originalLanguage) Object.defineProperty(navigator, "language", originalLanguage);
    if (originalLanguages) Object.defineProperty(navigator, "languages", originalLanguages);
    vi.restoreAllMocks();
  });

  /**
   * Force the environment to report only a raw POSIX locale, as WebKitGTK does
   * on a `C`-locale host — no valid tag anywhere in `navigator.language(s)`.
   */
  function setNavigatorLanguage(tag: string): void {
    Object.defineProperty(navigator, "language", { configurable: true, get: () => tag });
    Object.defineProperty(navigator, "languages", { configurable: true, get: () => [tag] });
  }

  it("resolveUiLocale sanitises a C/POSIX candidate to the default", () => {
    expect(locale.resolveUiLocale(["C"])).toBe(locale.DEFAULT_UI_LOCALE);
    expect(locale.resolveUiLocale(["POSIX"])).toBe(locale.DEFAULT_UI_LOCALE);
    // The default is a valid Intl tag, so constructing a formatter is safe.
    expect(() => new Intl.NumberFormat(locale.resolveUiLocale(["C"]))).not.toThrow();
  });

  it("numeric formatters never crash under a C locale, falling back to the default", () => {
    setNavigatorLanguage("C");
    // Under the raw "C" locale the safe-locale path resolves to en-US, so the
    // formatters must neither throw (the #2646 crash) nor change their output.
    expect(() => formatBytes(1536)).not.toThrow();
    expect(() => formatRate(23 * 1024)).not.toThrow();
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatRate(23 * 1024)).toBe("23 KB/s");
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
