import { describe, it, expect } from "vitest";
import { buildLatencyChartData, niceCeil } from "./latencyChartData";

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

  it("keeps a usable y range even when all values are tiny", () => {
    const { yMax } = buildLatencyChartData([1, 1, 1]);
    expect(yMax).toBeGreaterThanOrEqual(10);
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
    expect(yMax).toBeGreaterThanOrEqual(10);
    expect(drops).toEqual([0, 1]);
  });

  it("returns empty arrays for empty input", () => {
    const { data, drops } = buildLatencyChartData([]);
    expect(data[0]).toEqual([]);
    expect(data[1]).toEqual([]);
    expect(drops).toEqual([]);
  });
});
