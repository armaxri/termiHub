/**
 * Pure inputs for the {@link import("./MetricSparkline").MetricSparkline} uPlot
 * sparkline (PROD-0030). Kept separate from the component so the sample →
 * point-arrays transform is unit-testable without a DOM/canvas.
 */

/** A uPlot-ready sparkline data tuple. */
export interface SparklineData {
  /** uPlot data tuple: [x indices, series values]. Nulls are gaps. */
  data: [number[], (number | null)[]];
}

/**
 * Transform a value series into the `[xs, ys]` tuple uPlot needs. The x axis is
 * the sample index (a sparkline has no time axis), so N samples always produce N
 * points; `null` values are preserved as gaps.
 */
export function buildSparklineData(values: (number | null)[]): SparklineData {
  const xs = values.map((_, i) => i);
  const ys = values.slice();
  return { data: [xs, ys] };
}
