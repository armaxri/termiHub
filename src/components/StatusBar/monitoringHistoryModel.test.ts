import { describe, it, expect } from "vitest";
import { buildMetricBlocks, hasSamples, latestValue, networkMax } from "./monitoringHistoryModel";
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
  it("always includes CPU, memory and both network directions", () => {
    const blocks = buildMetricBlocks(emptyMonitorHistories());
    expect(blocks.map((b) => b.key)).toEqual(["cpu", "memory", "netRx", "netTx"]);
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
