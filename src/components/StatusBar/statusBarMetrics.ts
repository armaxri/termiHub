import type { AppSettings } from "@/types/connection";
import type { ConnectionConfig } from "@/types/terminal";
import { readConfigBoolean } from "@/utils/connectionConfigFields";

/** A host metric that can show as a chip in the status bar (#5754). */
export type StatusBarMetric = NonNullable<AppSettings["statusBarMetrics"]>[number];

/** Every selectable status-bar metric, in display order. */
export const STATUS_BAR_METRICS: readonly StatusBarMetric[] = [
  "cpu",
  "memory",
  "disk",
  "swap",
  "network",
];

/**
 * The chips shown when the user never chose a set (#5754). Swap is selectable
 * but not a default: on most hosts it is noise next to memory.
 */
export const DEFAULT_STATUS_BAR_METRICS: readonly StatusBarMetric[] = [
  "cpu",
  "memory",
  "disk",
  "network",
];

/** The user-facing label of each metric, for the settings checkboxes. */
export const STATUS_BAR_METRIC_LABELS: Record<StatusBarMetric, string> = {
  cpu: "CPU",
  memory: "Memory",
  disk: "Disk",
  swap: "Swap",
  network: "Network",
};

/**
 * The status-bar metric chips to show. An unset setting means the default set;
 * an explicit list (even an empty one) is the user's choice and is kept.
 */
export function resolveStatusBarMetrics(
  selected: AppSettings["statusBarMetrics"]
): ReadonlySet<StatusBarMetric> {
  return new Set(selected ?? DEFAULT_STATUS_BAR_METRICS);
}

/** The inputs that decide whether a tab collects host metrics. */
export interface MonitoringEnabledInput {
  /** Connection type of the tab (`"local"` for a local shell). */
  connectionType: string | null;
  /** The tab's connection config; its `enableMonitoring` override wins. */
  config: ConnectionConfig | undefined;
  /** The global "Power monitoring" default for remote sessions. */
  globalEnabled: boolean;
  /** The "Monitor local shells" setting; unset means off (#5754). */
  monitorLocalShells: boolean | undefined;
}

/**
 * Whether a tab that supports monitoring should collect host metrics.
 *
 * A connection's explicit `enableMonitoring` always wins. Otherwise remote
 * sessions follow the global default and local shells stay off unless the
 * user turned on "Monitor local shells" (#5754): the machine termiHub runs on
 * has its own system monitor, so its numbers are clutter by default.
 */
export function isMonitoringEnabledForTab({
  connectionType,
  config,
  globalEnabled,
  monitorLocalShells,
}: MonitoringEnabledInput): boolean {
  if (!config) return false;
  const override = readConfigBoolean(config, "enableMonitoring");
  if (override !== undefined) return override;
  if (connectionType === "local") return globalEnabled && monitorLocalShells === true;
  return globalEnabled;
}
