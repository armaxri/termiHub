import type { MonitorStatus, MonitorStatusReason } from "@/types/monitoring";

/**
 * Which chip a connected monitor shows while it has no sample yet (#5840).
 *
 * - `waiting` — the first reading is on its way (connecting, or live with no
 *   sample folded yet): a quiet "Waiting for stats…".
 * - `unavailable` — collects are failing before the first sample (stale or
 *   reconnecting): the host cannot report right now; the reason is in the tooltip.
 * - `unsupported` — the host has no stats source at all (#5471).
 * - `null` — another chip already says it: offline renders its own reason and
 *   Retry, paused its "Paused" badge.
 *
 * Without this the status bar showed only the host chip, so "loading", "off" and
 * "not supported" looked the same.
 */
export type StatslessMonitorChip = "waiting" | "unavailable" | "unsupported" | null;

/** Resolve the {@link StatslessMonitorChip} for a monitor with no stats sample. */
export function statslessMonitorChip(
  status: MonitorStatus | null,
  reason: MonitorStatusReason | null,
  paused: boolean
): StatslessMonitorChip {
  if (status === "offline") return null;
  if (reason === "unsupported") return "unsupported";
  if (status === "stale" || status === "reconnecting") return "unavailable";
  if (paused || status === "paused") return null;
  return "waiting";
}
