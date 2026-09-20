import { describe, it, expect } from "vitest";
import { buildSparklineData } from "./metricSparklineData";

describe("buildSparklineData", () => {
  it("produces N points from N samples, indexed by position", () => {
    const { data } = buildSparklineData([5, 10, 15, 20]);
    expect(data[0]).toEqual([0, 1, 2, 3]);
    expect(data[1]).toEqual([5, 10, 15, 20]);
    expect(data[0]).toHaveLength(4);
    expect(data[1]).toHaveLength(4);
  });

  it("preserves nulls as gaps", () => {
    const { data } = buildSparklineData([5, null, 15]);
    expect(data[1]).toEqual([5, null, 15]);
  });

  it("returns empty arrays for empty input", () => {
    const { data } = buildSparklineData([]);
    expect(data[0]).toEqual([]);
    expect(data[1]).toEqual([]);
  });

  it("does not mutate the input series", () => {
    const input: (number | null)[] = [1, 2, 3];
    buildSparklineData(input);
    expect(input).toEqual([1, 2, 3]);
  });
});
