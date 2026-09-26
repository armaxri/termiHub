/**
 * Pure helpers for the HTTP monitor's persisted check history (#3462).
 *
 * The backend records every check; the panel loads a monitor's stored series
 * and keeps appending live checks on top. These helpers merge the two and
 * shape a series for CSV export.
 */

import type { HttpCheckResult } from "@/types/network";
import { tableToCsv, type ResultTable } from "./exportResults";

/**
 * Merge a monitor's stored checks with live ones: timestamp-ordered, one entry
 * per timestamp (a live check may already be in the stored series), and capped
 * to the newest `max`.
 */
export function mergeChecks(
  stored: HttpCheckResult[] | undefined | null,
  live: HttpCheckResult[],
  max: number
): HttpCheckResult[] {
  const byTimestamp = new Map<number, HttpCheckResult>();
  for (const check of [...(Array.isArray(stored) ? stored : []), ...live]) {
    byTimestamp.set(check.timestampMs, check);
  }
  const merged = [...byTimestamp.values()].sort((a, b) => a.timestampMs - b.timestampMs);
  return merged.length > max ? merged.slice(merged.length - max) : merged;
}

/** A monitor's checks as a table (one row per check, ISO timestamps). */
export function httpMonitorChecksTable(checks: HttpCheckResult[]): ResultTable {
  return {
    columns: ["timestamp", "status_code", "latency_ms", "ok", "error"],
    rows: checks.map((c) => [
      new Date(c.timestampMs).toISOString(),
      c.statusCode ?? "",
      c.latencyMs ?? "",
      c.ok,
      c.error ?? "",
    ]),
  };
}

/** Serialize a monitor's checks to CSV (one row per check). */
export function httpMonitorChecksToCsv(checks: HttpCheckResult[]): string {
  return tableToCsv(httpMonitorChecksTable(checks));
}
