import { describe, it, expect } from "vitest";
import {
  alignBlockStarts,
  buildMetricBlocks,
  hasSamples,
  latestValue,
  networkMax,
  type MetricBlock,
} from "./monitoringHistoryModel";
import { emptyMonitorHistories, type MonitorHistories } from "@/store/useMonitorHistory";

function histories(overrides: Partial<MonitorHistories>): MonitorHistories {
  return { ...emptyMonitorHistories(), ...overrides };
}

describe("latestValue", () => {
  it("returns the last non-null value", () => {
    expect(latestValue([10, 20, 30])).toBe(30);
    expect(latestValue([10, 20, null])).toBe(20);
    expect(latestValue([null, null])).toBeNull();
    expect(latestValue([])).toBeNull();
  });
});

describe("hasSamples", () => {
  it("is false for empty or all-null series", () => {
    expect(hasSamples([])).toBe(false);
    expect(hasSamples([null, null])).toBe(false);
  });
  it("is true when any real sample exists", () => {
    expect(hasSamples([null, 5])).toBe(true);
  });
});

describe("networkMax", () => {
  it("floors at 1 KiB/s for an idle link", () => {
    expect(networkMax([0, null], [0])).toBe(1024);
  });
  it("uses the shared peak of rx and tx with headroom", () => {
    // tx peak 5000 dominates; 5000 * 1.2 = 6000.
    expect(networkMax([1000, 2000], [5000])).toBe(6000);
  });
});

describe("buildMetricBlocks", () => {
  it("always includes CPU, memory, disk and both network directions", () => {
    const blocks = buildMetricBlocks(emptyMonitorHistories());
    expect(blocks.map((b) => b.key)).toEqual(["cpu", "memory", "disk", "netRx", "netTx"]);
  });

  it("orders swap after disk, as in the status bar (#5628)", () => {
    const blocks = buildMetricBlocks(histories({ disk: [40], swap: [10] }));
    expect(blocks.map((b) => b.key)).toEqual(["cpu", "memory", "disk", "swap", "netRx", "netTx"]);
    expect(blocks.find((b) => b.key === "disk")?.max).toBe(100);
  });

  it("includes swap only when swap has samples", () => {
    const withSwap = buildMetricBlocks(histories({ swap: [10, 20] }));
    expect(withSwap.map((b) => b.key)).toContain("swap");
    const withoutSwap = buildMetricBlocks(histories({ swap: [null, null] }));
    expect(withoutSwap.map((b) => b.key)).not.toContain("swap");
  });

  it("flags hasData per block and shares the network scale", () => {
    const blocks = buildMetricBlocks(histories({ cpu: [50], netRx: [1000], netTx: [5000] }));
    const cpu = blocks.find((b) => b.key === "cpu");
    const mem = blocks.find((b) => b.key === "memory");
    const rx = blocks.find((b) => b.key === "netRx");
    const tx = blocks.find((b) => b.key === "netTx");
    expect(cpu?.hasData).toBe(true);
    expect(mem?.hasData).toBe(false);
    expect(cpu?.max).toBe(100);
    // Shared network ceiling: max(5000*1.2, 1024) = 6000 for both directions.
    expect(rx?.max).toBe(6000);
    expect(tx?.max).toBe(6000);
  });
});

describe("alignBlockStarts (#5840)", () => {
  function block(key: MetricBlock["key"], values: (number | null)[]): MetricBlock {
    return {
      key,
      label: key,
      unit: "percent",
      values,
      min: 0,
      max: 100,
      hasData: hasSamples(values),
    };
  }

  it("starts every sparkline at the latest first sample", () => {
    const aligned = alignBlockStarts([
      block("cpu", [null, 5, 6, 7]),
      block("memory", [40, 41, 42, 43]),
      block("netRx", [null, 1, 2, 3]),
    ]);
    expect(aligned.map((b) => b.values)).toEqual([
      [5, 6, 7],
      [41, 42, 43],
      [1, 2, 3],
    ]);
  });

  it("leaves aligned series and data-less blocks untouched", () => {
    const blocks = [block("memory", [1, 2]), block("disk", [3, 4])];
    expect(alignBlockStarts(blocks)).toBe(blocks);
    const withEmpty = [block("cpu", [null, 2]), block("swap", [null, null])];
    expect(alignBlockStarts(withEmpty).map((b) => b.values)).toEqual([[2], [null, null]]);
  });

  it("never trims more than a priming gap", () => {
    const aligned = alignBlockStarts([
      block("memory", [1, 2, 3, 4, 5, 6]),
      block("disk", [null, null, null, null, 9, 9]),
    ]);
    expect(aligned[0].values).toEqual([3, 4, 5, 6]);
  });
});
