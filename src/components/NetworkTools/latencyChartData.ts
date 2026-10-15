import { formatLatencyMs } from "@/utils/formatters";

/**
 * Smallest y-axis span (ms). Small enough that a sub-millisecond LAN series
 * (e.g. 0.2–0.5 ms) fills the chart instead of hugging the baseline (#4734),
 * yet large enough that an all-zero or all-drops series still has a sane axis.
 */
export const MIN_Y_RANGE_MS = 0.1;

/** Multiplicative headroom added above the largest latency value. */
const Y_HEADROOM = 1.15;

/**
 * Hysteresis for shrinking the y axis: an already-shown, larger bound is only
 * given up when the padded peak fits the smaller bound with this much slack
 * (padded peak ≤ 80 % of it). Growing is always immediate. This keeps the axis
 * from flapping between two nice bounds while values jitter around a boundary.
 */
const SHRINK_SLACK = 0.8;

/** Target number of intervals between y-axis ticks. */
const TARGET_TICK_INTERVALS = 5;

/** Strip floating-point noise (e.g. 0.30000000000000004 → 0.3). */
function clean(value: number): number {
  return Number(value.toPrecision(12));
}

/**
 * Round a value up to a "nice" axis bound (1/2/5 × 10ⁿ).
 *
 * Keeps y-axis labels human-readable (e.g. 44 → 50, 230 → 250, 0.37 → 0.5)
 * instead of landing on arbitrary fractional ticks. Non-positive or non-finite
 * input yields {@link MIN_Y_RANGE_MS}.
 */
export function niceCeil(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return MIN_Y_RANGE_MS;
  const exponent = Math.floor(Math.log10(value));
  const magnitude = Math.pow(10, exponent);
  const fraction = clean(value / magnitude);
  let niceFraction: number;
  if (fraction <= 1) niceFraction = 1;
  else if (fraction <= 2) niceFraction = 2;
  else if (fraction <= 5) niceFraction = 5;
  else niceFraction = 10;
  return clean(niceFraction * magnitude);
}

/**
 * Choose the y-axis upper bound (ms) for a series peak.
 *
 * The bound is the nice ceiling of the peak plus headroom, never below
 * {@link MIN_Y_RANGE_MS}. When the previously shown bound is passed, the axis
 * grows immediately but only shrinks once the peak clearly fits a smaller
 * bound (see {@link SHRINK_SLACK}), so a jittering series does not make the
 * axis jump back and forth.
 *
 * @param peak Largest latency in the visible series (ms); 0 when there is none.
 * @param previousYMax The bound currently on screen, if any.
 */
export function computeYMax(peak: number, previousYMax?: number): number {
  const padded = Number.isFinite(peak) && peak > 0 ? peak * Y_HEADROOM : 0;
  const target = Math.max(niceCeil(padded), MIN_Y_RANGE_MS);
  if (previousYMax == null || !Number.isFinite(previousYMax) || target >= previousYMax) {
    return target;
  }
  // Shrinking: only step down as far as the padded peak fits with slack.
  const shrinkTarget = Math.max(niceCeil(padded / SHRINK_SLACK), MIN_Y_RANGE_MS);
  return Math.min(previousYMax, shrinkTarget);
}

/**
 * Round a raw tick step up to a nice step (1/2/2.5/5 × 10ⁿ).
 */
function niceStep(raw: number): number {
  const exponent = Math.floor(Math.log10(raw));
  const magnitude = Math.pow(10, exponent);
  const fraction = clean(raw / magnitude);
  let niceFraction: number;
  if (fraction <= 1) niceFraction = 1;
  else if (fraction <= 2) niceFraction = 2;
  else if (fraction <= 2.5) niceFraction = 2.5;
  else if (fraction <= 5) niceFraction = 5;
  else niceFraction = 10;
  return clean(niceFraction * magnitude);
}

/**
 * Compute y-axis tick positions (ms) from 0 up to `yMax`.
 *
 * Uses a nice step giving about {@link TARGET_TICK_INTERVALS} intervals, so a
 * 0.5 ms axis ticks at 0, 0.1, …, 0.5 and a 200 ms axis at 0, 50, …, 200. Values
 * are cleaned of floating-point noise. A non-positive or non-finite `yMax`
 * yields just the baseline tick.
 */
export function computeLatencyTicks(yMax: number): number[] {
  if (!Number.isFinite(yMax) || yMax <= 0) return [0];
  const step = niceStep(yMax / TARGET_TICK_INTERVALS);
  const count = Math.floor(clean(yMax / step));
  const ticks: number[] = [];
  for (let i = 0; i <= count; i++) ticks.push(clean(i * step));
  return ticks;
}

/** Format y-axis tick values as latency labels (e.g. `0.25ms`, `1,000ms`). */
export function formatLatencyTicks(ticks: number[]): string[] {
  return ticks.map((v) => formatLatencyMs(v));
}

/** Pure, testable inputs for a uPlot latency chart. */
export interface LatencyChartData {
  /** uPlot data tuple: [x values, latency series]. Nulls in the series are gaps (drops). */
  data: [number[], (number | null)[]];
  /** Y-axis lower bound (ms) — always 0 so latency is read against a real baseline. */
  yMin: number;
  /**
   * Y-axis upper bound (ms), rounded to a nice value with headroom. Stateless;
   * a live chart feeds {@link peak} through {@link computeYMax} with its
   * previous bound instead, to get shrink hysteresis.
   */
  yMax: number;
  /** Largest non-null latency in the series (ms); 0 when there is none. */
  peak: number;
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
 * value above the peak (see {@link computeYMax}). Timed-out samples stay `null`
 * so uPlot draws a gap and their positions are surfaced separately as drop
 * markers.
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
  const yMax = computeYMax(peak);

  const drops = points
    .map((p, i) => (p == null ? i * xStep : null))
    .filter((x): x is number => x != null);

  return { data: [xs, ys], yMin: 0, yMax, peak, drops };
}
