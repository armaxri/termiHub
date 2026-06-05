/** Smallest y-axis span (ms) so a flat, low-latency series stays readable. */
const MIN_Y_RANGE_MS = 10;

/** Multiplicative headroom added above the largest latency value. */
const Y_HEADROOM = 1.15;

/**
 * Round a value up to a "nice" axis bound (1/2/5 × 10ⁿ).
 *
 * Keeps y-axis labels human-readable (e.g. 44 → 50, 230 → 250) instead of
 * landing on arbitrary fractional ticks.
 */
export function niceCeil(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return MIN_Y_RANGE_MS;
  const exponent = Math.floor(Math.log10(value));
  const magnitude = Math.pow(10, exponent);
  const fraction = value / magnitude;
  let niceFraction: number;
  if (fraction <= 1) niceFraction = 1;
  else if (fraction <= 2) niceFraction = 2;
  else if (fraction <= 5) niceFraction = 5;
  else niceFraction = 10;
  return niceFraction * magnitude;
}

/** Pure, testable inputs for a uPlot latency chart. */
export interface LatencyChartData {
  /** uPlot data tuple: [x values, latency series]. Nulls in the series are gaps (drops). */
  data: [number[], (number | null)[]];
  /** Y-axis lower bound (ms) — always 0 so latency is read against a real baseline. */
  yMin: number;
  /** Y-axis upper bound (ms), rounded to a nice value with headroom. */
  yMax: number;
  /** X positions (in x-axis units) of dropped/timed-out samples, for drop markers. */
  drops: number[];
}

/**
 * Transform a latency sample series into the arrays and axis bounds a uPlot
 * chart needs.
 *
 * The x axis is the sample index, converted to elapsed seconds when
 * `intervalMs` is provided. The y axis is baselined at 0 (so a 5→10ms change
 * reads as a small change, not a dramatic slope) and capped at a nice rounded
 * value above the peak. Timed-out samples stay `null` so uPlot draws a gap and
 * their positions are surfaced separately as drop markers.
 *
 * @param points Latency values in ms; `null` marks a timeout/drop.
 * @param intervalMs Sampling interval; when set, x values become elapsed seconds.
 */
export function buildLatencyChartData(
  points: (number | null)[],
  intervalMs?: number
): LatencyChartData {
  const xStep = intervalMs != null ? intervalMs / 1000 : 1;
  const xs: number[] = points.map((_, i) => i * xStep);
  const ys: (number | null)[] = points.map((p) => (p == null ? null : p));

  const valid = points.filter((p): p is number => p != null);
  const peak = valid.length > 0 ? Math.max(...valid) : 0;
  const yMax = Math.max(niceCeil(peak * Y_HEADROOM), MIN_Y_RANGE_MS);

  const drops = points
    .map((p, i) => (p == null ? i * xStep : null))
    .filter((x): x is number => x != null);

  return { data: [xs, ys], yMin: 0, yMax, drops };
}
