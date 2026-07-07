import { describe, it, expect } from "vitest";
import { isMonitorStale, formatCheckedAgo } from "./monitorStaleness";

describe("isMonitorStale (audit gap #11)", () => {
  const NOW = 1_000_000_000_000;
  const INTERVAL = 30_000; // 30s

  it("is not stale when the last check is fresh (within one interval)", () => {
    expect(isMonitorStale(NOW - 10_000, INTERVAL, NOW)).toBe(false);
  });

  it("is not stale exactly at 2× interval (boundary is exclusive)", () => {
    expect(isMonitorStale(NOW - 2 * INTERVAL, INTERVAL, NOW)).toBe(false);
  });

  it("is stale once the last check is older than 2× interval", () => {
    expect(isMonitorStale(NOW - (2 * INTERVAL + 1), INTERVAL, NOW)).toBe(true);
  });

  it("is stale for a long-interval monitor that died minutes ago", () => {
    const fiveMin = 5 * 60_000;
    // Last checked 11 minutes ago with a 5-minute interval → overdue.
    expect(isMonitorStale(NOW - 11 * 60_000, fiveMin, NOW)).toBe(true);
  });

  it("is never stale when it has not been checked yet", () => {
    expect(isMonitorStale(undefined, INTERVAL, NOW)).toBe(false);
  });

  it("is never stale for a non-positive interval", () => {
    expect(isMonitorStale(NOW - 999_999, 0, NOW)).toBe(false);
  });
});

describe("formatCheckedAgo (audit gap #11)", () => {
  const NOW = 1_000_000_000_000;

  it("reads 'just now' for sub-2s ages", () => {
    expect(formatCheckedAgo(NOW - 500, NOW)).toBe("just now");
  });

  it("uses second granularity", () => {
    expect(formatCheckedAgo(NOW - 5_000, NOW)).toBe("5s ago");
  });

  it("uses minute granularity", () => {
    expect(formatCheckedAgo(NOW - 3 * 60_000, NOW)).toBe("3m ago");
  });

  it("uses hour granularity", () => {
    expect(formatCheckedAgo(NOW - 2 * 3_600_000, NOW)).toBe("2h ago");
  });

  it("uses day granularity", () => {
    expect(formatCheckedAgo(NOW - 25 * 3_600_000, NOW)).toBe("1d ago");
  });

  it("never returns a negative age for clock skew", () => {
    expect(formatCheckedAgo(NOW + 5_000, NOW)).toBe("just now");
  });
});
