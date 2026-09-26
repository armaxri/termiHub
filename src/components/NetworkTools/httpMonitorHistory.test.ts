/**
 * Unit tests for the HTTP monitor check-history helpers (#3462): merging the
 * persisted checks with live ones, and the CSV export shape.
 */
import { describe, it, expect } from "vitest";
import type { HttpCheckResult } from "@/types/network";
import { httpMonitorChecksToCsv, mergeChecks } from "./httpMonitorHistory";

function check(timestampMs: number, overrides: Partial<HttpCheckResult> = {}): HttpCheckResult {
  return {
    monitorId: "mon-1",
    statusCode: 200,
    latencyMs: 10,
    ok: true,
    timestampMs,
    ...overrides,
  };
}

describe("mergeChecks", () => {
  it("combines stored and live checks in timestamp order without duplicates", () => {
    const merged = mergeChecks([check(1), check(3)], [check(3), check(2), check(4)], 10);
    expect(merged.map((c) => c.timestampMs)).toEqual([1, 2, 3, 4]);
  });

  it("keeps only the newest `max` checks", () => {
    const merged = mergeChecks([check(1), check(2)], [check(3), check(4)], 3);
    expect(merged.map((c) => c.timestampMs)).toEqual([2, 3, 4]);
  });

  it("tolerates a non-array stored value", () => {
    expect(mergeChecks(undefined, [check(1)], 5)).toHaveLength(1);
  });
});

describe("httpMonitorChecksToCsv", () => {
  it("writes one row per check with an ISO timestamp and quoted errors", () => {
    const csv = httpMonitorChecksToCsv([
      check(0),
      check(1_000, {
        ok: false,
        statusCode: undefined,
        latencyMs: undefined,
        error: "connect failed, refused",
      }),
    ]);
    expect(csv).toBe(
      [
        "timestamp,status_code,latency_ms,ok,error",
        "1970-01-01T00:00:00.000Z,200,10,true,",
        '1970-01-01T00:00:01.000Z,,,false,"connect failed, refused"',
        "",
      ].join("\n")
    );
  });
});
