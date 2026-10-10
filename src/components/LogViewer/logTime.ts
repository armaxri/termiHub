/**
 * Timestamp handling for Log Viewer rows (#4536).
 *
 * Frontend and backend entries both carry `timestampMs` (Unix epoch ms) as the
 * single source of truth: rows are ordered by it and displayed from it in one
 * locale-aware format, and exports render it as ISO-8601 UTC. The string
 * `timestamp` is only a fallback for entries without `timestampMs` (payloads
 * from a backend that predates #4536).
 */
import type { LogEntry } from "@/types/terminal";
import { formatLogTime } from "@/utils/formatters";

/**
 * The entry's epoch-ms sort key: `timestampMs`, else a parse of an ISO-8601
 * `timestamp`. `undefined` when neither is usable (a legacy backend
 * `HH:MM:SS.mmm` string has no date and cannot be placed on the timeline).
 */
export function entryTimeMs(entry: LogEntry): number | undefined {
  if (typeof entry.timestampMs === "number" && Number.isFinite(entry.timestampMs)) {
    return entry.timestampMs;
  }
  if (!entry.timestamp.includes("T")) return undefined;
  const parsed = Date.parse(entry.timestamp);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** The row's display time: locale `HH:MM:SS.mmm`, or the raw string as a fallback. */
export function displayTimestamp(entry: LogEntry): string {
  const ms = entryTimeMs(entry);
  return ms === undefined ? entry.timestamp : formatLogTime(ms);
}

/** The time written to a saved/copied log: ISO-8601 UTC, or the raw string as a fallback. */
export function exportTimestamp(entry: LogEntry): string {
  const ms = entryTimeMs(entry);
  return ms === undefined ? entry.timestamp : new Date(ms).toISOString();
}

/**
 * Merge two individually chronological entry lists into one chronological list
 * (a stable two-way merge: each list keeps its own order, and on a tie `first`
 * wins). An entry without a usable time is emitted in place in its own list —
 * it never reorders the other list around it.
 */
export function mergeChronological(first: LogEntry[], second: LogEntry[]): LogEntry[] {
  const merged: LogEntry[] = [];
  let i = 0;
  let j = 0;
  while (i < first.length && j < second.length) {
    const a = entryTimeMs(first[i]);
    const b = entryTimeMs(second[j]);
    if (a === undefined) merged.push(first[i++]);
    else if (b === undefined) merged.push(second[j++]);
    else merged.push(a <= b ? first[i++] : second[j++]);
  }
  while (i < first.length) merged.push(first[i++]);
  while (j < second.length) merged.push(second[j++]);
  return merged;
}
