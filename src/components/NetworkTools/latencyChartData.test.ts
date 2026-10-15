import { describe, it, expect } from "vitest";
import {
  MIN_Y_RANGE_MS,
  buildLatencyChartData,
  computeLatencyTicks,
  computeYMax,
  formatLatencyTicks,
  niceCeil,
} from "./latencyChartData";

describe("niceCeil", () => {
  it("rounds small values up to readable steps", () => {
    expect(niceCeil(5)).toBeGreaterThanOrEqual(5);
    expect(niceCeil(44)).toBeGreaterThanOrEqual(44);
    expect(niceCeil(44)).toBeLessThanOrEqual(60);
  });

  it("never returns less than the input", () => {
    for (const v of [1, 7, 13, 99, 101, 250, 999, 1234]) {
      expect(niceCeil(v)).toBeGreaterThanOrEqual(v);
    }
  });

  it("rounds sub-millisecond values to nice fractional bounds", () => {
    expect(niceCeil(0.37)).toBe(0.5);
    expect(niceCeil(0.12)).toBe(0.2);
    expect(niceCeil(0.3)).toBe(0.5);
    expect(niceCeil(0.05)).toBe(0.05);
    expect(niceCeil(0.5)).toBe(0.5);
  });

  it("returns exact powers of ten without floating-point drift", () => {
    expect(niceCeil(0.1)).toBe(0.1);
    expect(niceCeil(1)).toBe(1);
    expect(niceCeil(1000)).toBe(1000);
  });

  it("returns a positive value for zero/negative input", () => {
    expect(niceCeil(0)).toBeGreaterThan(0);
    expect(niceCeil(-5)).toBeGreaterThan(0);
  });
});

describe("buildLatencyChartData", () => {
  it("uses the sample index for x when no interval is given", () => {
    const { data } = buildLatencyChartData([5, 10, 15]);
    expect(data[0]).toEqual([0, 1, 2]);
    expect(data[1]).toEqual([5, 10, 15]);
  });

  it("converts the x axis to elapsed seconds when an interval is given", () => {
    const { data } = buildLatencyChartData([5, 10, 15], 1000);
    expect(data[0]).toEqual([0, 1, 2]);
  });

  it("scales elapsed seconds by the interval", () => {
    const { data } = buildLatencyChartData([1, 2, 3], 500);
    expect(data[0]).toEqual([0, 0.5, 1]);
  });

  it("baselines the y axis at zero", () => {
    const { yMin } = buildLatencyChartData([20, 30, 44]);
    expect(yMin).toBe(0);
  });

  it("pads the y maximum above the largest latency", () => {
    const { yMax } = buildLatencyChartData([5, 10, 44]);
    expect(yMax).toBeGreaterThan(44);
  });

  it("fits a low-millisecond series instead of forcing a 10 ms span (#4734)", () => {
    const { yMax } = buildLatencyChartData([1, 1, 1]);
    expect(yMax).toBe(2);
  });

  it("scales the y axis to a sub-millisecond series (#4734)", () => {
    const { yMax, peak } = buildLatencyChartData([0.21, 0.35, 0.42, 0.28]);
    expect(peak).toBe(0.42);
    expect(yMax).toBe(0.5);
  });

  it("scales a mixed sub-ms / low-ms series to its peak", () => {
    const { yMax } = buildLatencyChartData([0.3, 0.4, 3.2, 0.5]);
    expect(yMax).toBe(5);
  });

  it("leaves WAN-scale series on their existing bounds", () => {
    expect(buildLatencyChartData([5, 10, 44]).yMax).toBe(100);
    expect(buildLatencyChartData([20, 30, 40]).yMax).toBe(50);
    expect(buildLatencyChartData([180, 230, 210]).yMax).toBe(500);
    expect(buildLatencyChartData([1200, 1500]).yMax).toBe(2000);
  });

  it("falls back to the minimum span for an all-zero series", () => {
    const { yMax, peak } = buildLatencyChartData([0, 0, 0]);
    expect(peak).toBe(0);
    expect(yMax).toBe(MIN_Y_RANGE_MS);
  });

  it("keeps nulls in the series so uPlot renders gaps", () => {
    const { data } = buildLatencyChartData([5, null, 15]);
    expect(data[1]).toEqual([5, null, 15]);
  });

  it("reports the x positions of dropped samples", () => {
    const { drops } = buildLatencyChartData([5, null, 15, null], 1000);
    expect(drops).toEqual([1, 3]);
  });

  it("handles an all-drops series without throwing", () => {
    const { data, yMax, drops } = buildLatencyChartData([null, null]);
    expect(data[1]).toEqual([null, null]);
    expect(yMax).toBe(MIN_Y_RANGE_MS);
    expect(drops).toEqual([0, 1]);
  });

  it("returns empty arrays for empty input", () => {
    const { data, drops, yMax } = buildLatencyChartData([]);
    expect(yMax).toBe(MIN_Y_RANGE_MS);
    expect(data[0]).toEqual([]);
    expect(data[1]).toEqual([]);
    expect(drops).toEqual([]);
  });
});

describe("computeYMax (#4734)", () => {
  it("adds headroom above the peak and rounds to a nice bound", () => {
    expect(computeYMax(0.42)).toBe(0.5);
    expect(computeYMax(0.45)).toBe(1);
    expect(computeYMax(8)).toBe(10);
    expect(computeYMax(44)).toBe(100);
  });

  it("never drops below the minimum span", () => {
    expect(computeYMax(0)).toBe(MIN_Y_RANGE_MS);
    expect(computeYMax(0.01)).toBe(MIN_Y_RANGE_MS);
    expect(computeYMax(Number.NaN)).toBe(MIN_Y_RANGE_MS);
    expect(computeYMax(-3)).toBe(MIN_Y_RANGE_MS);
  });

  it("grows immediately when the peak exceeds the shown bound", () => {
    expect(computeYMax(0.6, 0.5)).toBe(1);
    expect(computeYMax(40, 1)).toBe(50);
  });

  it("does not flap while values jitter around a nice boundary", () => {
    // 0.43 ms × headroom ≈ 0.49 → 0.5; 0.44 ms × headroom ≈ 0.51 → 1.
    let yMax = computeYMax(0.43);
    expect(yMax).toBe(0.5);
    yMax = computeYMax(0.44, yMax);
    expect(yMax).toBe(1);
    for (const peak of [0.43, 0.44, 0.42, 0.44, 0.41, 0.43]) {
      yMax = computeYMax(peak, yMax);
      expect(yMax).toBe(1);
    }
  });

  it("shrinks once the peak clearly fits a smaller bound", () => {
    expect(computeYMax(0.3, 1)).toBe(0.5);
    expect(computeYMax(0.42, 100)).toBe(1);
    expect(computeYMax(0, 50)).toBe(MIN_Y_RANGE_MS);
  });

  it("is stable when fed its own result", () => {
    for (const [peak, prev] of [
      [0.43, 1],
      [0.3, 1],
      [44, 500],
      [0, 10],
    ]) {
      const once = computeYMax(peak, prev);
      expect(computeYMax(peak, once)).toBe(once);
    }
  });
});

describe("computeLatencyTicks (#4734)", () => {
  it("ticks a sub-millisecond axis in clean fractional steps", () => {
    expect(computeLatencyTicks(0.5)).toEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5]);
    expect(computeLatencyTicks(0.1)).toEqual([0, 0.02, 0.04, 0.06, 0.08, 0.1]);
    expect(computeLatencyTicks(0.2)).toEqual([0, 0.05, 0.1, 0.15, 0.2]);
  });

  it("ticks a low-millisecond axis", () => {
    expect(computeLatencyTicks(1)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    expect(computeLatencyTicks(2)).toEqual([0, 0.5, 1, 1.5, 2]);
    expect(computeLatencyTicks(5)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("ticks a large axis", () => {
    expect(computeLatencyTicks(100)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(computeLatencyTicks(500)).toEqual([0, 100, 200, 300, 400, 500]);
    expect(computeLatencyTicks(2000)).toEqual([0, 500, 1000, 1500, 2000]);
  });

  it("never exceeds the bound for a non-nice maximum", () => {
    const ticks = computeLatencyTicks(7);
    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]).toBeLessThanOrEqual(7);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
  });

  it("returns only the baseline for a degenerate bound", () => {
    expect(computeLatencyTicks(0)).toEqual([0]);
    expect(computeLatencyTicks(-1)).toEqual([0]);
    expect(computeLatencyTicks(Number.NaN)).toEqual([0]);
  });

  it("covers the y bound chosen for every series shape", () => {
    for (const points of [[0.2, 0.4], [0.3, 3.2], [5, 44], [0, 0], [], [null]]) {
      const { yMax } = buildLatencyChartData(points);
      const ticks = computeLatencyTicks(yMax);
      expect(ticks[ticks.length - 1]).toBe(yMax);
    }
  });
});

describe("formatLatencyTicks (#4734)", () => {
  it("formats sub-millisecond ticks with fractional precision", () => {
    expect(formatLatencyTicks(computeLatencyTicks(0.5))).toEqual([
      "0ms",
      "0.1ms",
      "0.2ms",
      "0.3ms",
      "0.4ms",
      "0.5ms",
    ]);
    expect(formatLatencyTicks([0, 0.02, 0.05, 0.15])).toEqual([
      "0ms",
      "0.02ms",
      "0.05ms",
      "0.15ms",
    ]);
  });

  it("formats large ticks as whole, grouped milliseconds", () => {
    expect(formatLatencyTicks([0, 500, 1000, 1500, 2000])).toEqual([
      "0ms",
      "500ms",
      "1,000ms",
      "1,500ms",
      "2,000ms",
    ]);
  });

  it("returns no labels for no ticks", () => {
    expect(formatLatencyTicks([])).toEqual([]);
  });
});
