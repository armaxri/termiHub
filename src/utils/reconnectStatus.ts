/**
 * Shared reconnect status wording (SM-020, #3730).
 *
 * Every surface that shows an automatic reconnect — terminal tabs, graphical
 * (VNC/RDP) tabs and the monitoring status bar — words it the same way, so a
 * dropped link reads identically wherever it happens:
 *
 * - heading: {@link RECONNECTING_HEADING} ("Connection lost — reconnecting…");
 * - progress: {@link reconnectAttemptLabel} ("Attempt 3 of 10"), the budget being
 *   the shared `RECONNECT_POLICY.maxAttempts`;
 * - monitoring: one badge at a time, by {@link monitorStatusBadge}'s precedence.
 */
import type { MonitorStatus } from "@/types/monitoring";

/** The heading shown while an automatic reconnect loop is running. */
export const RECONNECTING_HEADING = "Connection lost — reconnecting…";

/**
 * The attempt-progress label for a running reconnect loop: `Attempt n of N`, or
 * `Attempt n` for an unbounded budget. `attempt` is the 1-based attempt the loop
 * is on (or about to start); values below 1 read as 1.
 */
export function reconnectAttemptLabel(attempt: number, maxAttempts: number): string {
  const n = Math.max(1, Math.floor(attempt));
  return maxAttempts > 0 ? `Attempt ${n} of ${maxAttempts}` : `Attempt ${n}`;
}

/** The single status badge the monitoring status bar shows next to its stats. */
export type MonitorStatusBadge = "offline" | "reconnecting" | "stale" | "paused" | null;

/**
 * Which monitoring badge to show, one at a time, by precedence (#3730):
 *
 * 1. `offline` — the reconnect budget is spent (or the remote cannot be read);
 *    it carries the Retry affordance, so it outranks everything.
 * 2. `reconnecting` — the transport dropped and the shared-policy re-dial loop is
 *    running (the terminal tab's "reconnecting" twin).
 * 3. `stale` — samples stopped arriving but no re-dial has started yet.
 * 4. `paused` — the user paused collection; the connection is fine.
 *
 * A link problem always outranks a user pause, so a paused monitor whose
 * connection drops shows the problem rather than a reassuring "Paused".
 */
export function monitorStatusBadge(
  status: MonitorStatus | null,
  paused: boolean
): MonitorStatusBadge {
  if (status === "offline") return "offline";
  if (status === "reconnecting") return "reconnecting";
  if (status === "stale") return "stale";
  if (paused || status === "paused") return "paused";
  return null;
}

/** Whether a badge means the shown numbers are frozen (dimmed, not live). */
export function isFrozenMonitorBadge(badge: MonitorStatusBadge): boolean {
  return badge === "reconnecting" || badge === "stale" || badge === "paused";
}
