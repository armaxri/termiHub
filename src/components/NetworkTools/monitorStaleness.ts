/**
 * Staleness helpers for HTTP monitors (audit gap #11).
 *
 * The backend poller emits a check result only once per `intervalMs`, so the
 * sidebar dot can keep showing a stale "up" for the whole interval (minutes, if
 * the interval is long) after an endpoint has actually died. These pure helpers
 * let the UI show a relative "checked N ago" label and flag a monitor as
 * overdue when it has missed more than one expected poll — without touching the
 * Rust poller.
 */

/**
 * A monitor is considered stale/overdue when the time since its last check
 * exceeds twice its configured poll interval, i.e. it has missed more than one
 * expected poll. `now` is injectable for deterministic tests.
 *
 * @param timestampMs - epoch millis of the last check (`undefined` = never checked yet)
 * @param intervalMs - configured poll interval in millis
 * @param now - current epoch millis (defaults to `Date.now()`)
 */
export function isMonitorStale(
  timestampMs: number | undefined,
  intervalMs: number,
  now: number = Date.now()
): boolean {
  if (timestampMs === undefined) return false;
  if (intervalMs <= 0) return false;
  return now - timestampMs > 2 * intervalMs;
}

/**
 * Format the age of a monitor's last check as a compact relative string
 * ("just now", "5s ago", "3m ago", "2h ago", "1d ago"). Second-level
 * granularity matters here: monitors often poll every few seconds, so the
 * coarser minute-based `formatRelativeTime` would read "just now" for a monitor
 * that is already overdue.
 *
 * @param timestampMs - epoch millis of the last check
 * @param now - current epoch millis (defaults to `Date.now()`)
 */
export function formatCheckedAgo(timestampMs: number, now: number = Date.now()): string {
  const diffMs = Math.max(0, now - timestampMs);
  const diffSecs = Math.floor(diffMs / 1000);
  if (diffSecs < 2) return "just now";
  if (diffSecs < 60) return `${diffSecs}s ago`;
  const diffMins = Math.floor(diffSecs / 60);
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}
