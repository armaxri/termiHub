import type { SystemStats } from "@/types/monitoring";
import type { StatsMetric } from "@/types/generated/StatsMetric";

/**
 * Whether `metric` is listed as unavailable for this sample (#3202).
 *
 * The Docker stats fallback cannot supply load average, uptime, disk, swap,
 * per-core CPU or the process list; their numeric fields hold placeholder zeros
 * that must render as "unavailable", never as a real reading. Samples from
 * older backends omit the list and are treated as fully available.
 */
export function isMetricUnavailable(stats: SystemStats, metric: StatsMetric): boolean {
  return stats.unavailableMetrics?.includes(metric) ?? false;
}

/**
 * Human-readable label for a sample's collection source, or `null` for the
 * default `/proc` source (which stays unlabelled).
 */
export function statsSourceLabel(stats: SystemStats): string | null {
  return stats.source === "dockerStats" ? "via Docker stats" : null;
}

/** Tooltip text explaining why `label` has no value in this sample. */
export function unavailableTitle(label: string, stats: SystemStats): string {
  const source = statsSourceLabel(stats);
  return source ? `${label}: unavailable ${source}` : `${label}: unavailable`;
}
