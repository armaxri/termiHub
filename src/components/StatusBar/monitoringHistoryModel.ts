/**
 * Pure model for the monitoring history panel (PROD-0030). Turns the rolling
 * {@link MonitorHistories} into an ordered list of metric "blocks" — each a
 * labelled series with its own y-range and unit — so the panel component is a
 * thin render over testable data rather than carrying the shaping logic itself.
 */

import type { MonitorHistories, MonitorMetricKey } from "@/store/useMonitorHistory";

/** How a metric's value should be formatted / y-scaled. */
export type MetricUnit = "percent" | "rate";

/** A single chart block in the monitoring history panel. */
export interface MetricBlock {
  /** Which tracked metric this block renders. */
  key: MonitorMetricKey;
  /** Human-readable label (e.g. "CPU", "Net ↓"). */
  label: string;
  /** Percentage vs. byte-rate — drives formatting and axis scaling. */
  unit: MetricUnit;
  /** The rolling values (oldest first); `null` entries are gaps. */
  values: (number | null)[];
  /** Y-axis lower bound. */
  min: number;
  /** Y-axis upper bound. */
  max: number;
  /** True once at least one real (non-null) sample exists. */
  hasData: boolean;
}

/** The latest non-null value in a series, or `null` when there is none. */
export function latestValue(values: (number | null)[]): number | null {
  for (let i = values.length - 1; i >= 0; i -= 1) {
    const v = values[i];
    if (v != null) return v;
  }
  return null;
}

/** Whether a series carries any real (non-null) sample. */
export function hasSamples(values: (number | null)[]): boolean {
  return values.some((v) => v != null);
}

/** Smallest network y-axis span (1 KiB/s) so a quiet link stays readable. */
const MIN_RATE_MAX = 1024;
/** Multiplicative headroom above the peak rate. */
const RATE_HEADROOM = 1.2;

/**
 * A y-axis upper bound for a shared network scale: the peak of both series with
 * headroom, floored so an idle link does not collapse to a zero-height range.
 * rx and tx share one scale so the two charts read as comparable.
 */
export function networkMax(rx: (number | null)[], tx: (number | null)[]): number {
  let peak = 0;
  for (const v of [...rx, ...tx]) {
    if (v != null && v > peak) peak = v;
  }
  return Math.max(MIN_RATE_MAX, Math.ceil(peak * RATE_HEADROOM));
}

/**
 * Build the ordered metric blocks for the panel. Swap is included only when the
 * host actually has swap history (a swapless host records only gaps), matching
 * the status bar's "hide Swap when absent" rule.
 */
export function buildMetricBlocks(histories: MonitorHistories): MetricBlock[] {
  const netCeil = networkMax(histories.netRx, histories.netTx);
  const blocks: Omit<MetricBlock, "hasData">[] = [
    { key: "cpu", label: "CPU", unit: "percent", values: histories.cpu, min: 0, max: 100 },
    { key: "memory", label: "Memory", unit: "percent", values: histories.memory, min: 0, max: 100 },
  ];
  if (hasSamples(histories.swap)) {
    blocks.push({
      key: "swap",
      label: "Swap",
      unit: "percent",
      values: histories.swap,
      min: 0,
      max: 100,
    });
  }
  blocks.push(
    { key: "netRx", label: "Net ↓", unit: "rate", values: histories.netRx, min: 0, max: netCeil },
    { key: "netTx", label: "Net ↑", unit: "rate", values: histories.netTx, min: 0, max: netCeil }
  );
  return blocks.map((b) => ({ ...b, hasData: hasSamples(b.values) }));
}
