import type { SystemStats } from "@/types/monitoring";
import { unavailableTitle } from "./monitoringAvailability";

/** Props for {@link UnavailableStat}. */
interface UnavailableStatProps {
  /** Short metric label shown in the status bar, e.g. "Disk". */
  label: string;
  /** The sample the metric is missing from (drives the tooltip's source). */
  stats: SystemStats;
  /** Test id of the stat token this placeholder replaces. */
  testId: string;
  /** The stale/reconnecting modifier class suffix, or "". */
  staleModifier: string;
}

/**
 * Status-bar placeholder for a metric the sample could not supply (#3202) —
 * e.g. disk usage for a container sampled via the Docker stats API. Renders a
 * muted "Disk n/a" rather than a misleading "Disk 0%".
 */
export function UnavailableStat({ label, stats, testId, staleModifier }: UnavailableStatProps) {
  return (
    <span
      className={`status-bar__item monitoring-status__stat monitoring-status__stat--unavailable${staleModifier}`}
      title={unavailableTitle(label, stats)}
      data-testid={testId}
      data-unavailable="true"
    >
      {label} n/a
    </span>
  );
}
