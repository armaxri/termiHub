import { describe, it, expect } from "vitest";
import {
  foldMonitorSample,
  initialMonitorHistoryState,
  MONITOR_HISTORY_CAP,
  type MonitorHistoryState,
  type MonitorMetricValues,
} from "./useMonitorHistory";

/** A metric-values record where every metric shares one value (test convenience). */
function all(value: number | null): MonitorMetricValues {
  return { cpu: value, memory: value, swap: value, netRx: value, netTx: value };
}

/** Feed a run of samples through the fold, returning the final state. */
function foldSequence(
  inputs: { key: string | null; sampleCount: number; values: MonitorMetricValues }[],
  capacity = MONITOR_HISTORY_CAP
): MonitorHistoryState {
  return inputs.reduce(
    (state, input) => foldMonitorSample(state, input, capacity),
    initialMonitorHistoryState
  );
}

describe("foldMonitorSample (multi-metric)", () => {
  it("produces N points per metric from N distinct samples", () => {
    const inputs = Array.from({ length: 5 }, (_, i) => ({
      key: "sess-1",
      sampleCount: i + 1,
      values: all((i + 1) * 10),
    }));
    const { series } = foldSequence(inputs);
    expect(series.cpu).toEqual([10, 20, 30, 40, 50]);
    expect(series.memory).toEqual([10, 20, 30, 40, 50]);
    expect(series.netRx).toEqual([10, 20, 30, 40, 50]);
  });

  it("tracks each metric independently", () => {
    const { series } = foldSequence([
      {
        key: "sess-1",
        sampleCount: 1,
        values: { cpu: 1, memory: 2, swap: 3, netRx: 4, netTx: 5 },
      },
      {
        key: "sess-1",
        sampleCount: 2,
        values: { cpu: 11, memory: 22, swap: 33, netRx: 44, netTx: 55 },
      },
    ]);
    expect(series.cpu).toEqual([1, 11]);
    expect(series.memory).toEqual([2, 22]);
    expect(series.swap).toEqual([3, 33]);
    expect(series.netRx).toEqual([4, 44]);
    expect(series.netTx).toEqual([5, 55]);
  });

  it("caps every window and evicts oldest across a long stream", () => {
    const inputs = Array.from({ length: 200 }, (_, i) => ({
      key: "sess-1",
      sampleCount: i + 1,
      values: all(i + 1),
    }));
    const { series } = foldSequence(inputs, 60);
    expect(series.cpu).toHaveLength(60);
    expect(series.cpu[0]).toBe(141);
    expect(series.cpu[series.cpu.length - 1]).toBe(200);
  });

  it("ignores a repeated sample count so paused/stale holds rather than duplicates", () => {
    const { series } = foldSequence([
      { key: "sess-1", sampleCount: 1, values: all(10) },
      { key: "sess-1", sampleCount: 2, values: all(20) },
      // Same count re-delivered (a re-render with no new sample): no new point.
      { key: "sess-1", sampleCount: 2, values: all(20) },
      { key: "sess-1", sampleCount: 2, values: all(20) },
    ]);
    expect(series.cpu).toEqual([10, 20]);
  });

  it("resets the window when the monitor key changes", () => {
    const first = foldSequence([
      { key: "sess-1", sampleCount: 1, values: all(10) },
      { key: "sess-1", sampleCount: 2, values: all(20) },
    ]);
    const switched = foldMonitorSample(
      first,
      { key: "sess-2", sampleCount: 4, values: all(99) },
      60
    );
    expect(switched.key).toBe("sess-2");
    expect(switched.series.cpu).toEqual([99]);
  });

  it("resets the window when sampleCount goes backwards (reconnect)", () => {
    const before = foldSequence([
      { key: "sess-1", sampleCount: 5, values: all(50) },
      { key: "sess-1", sampleCount: 6, values: all(60) },
    ]);
    // A fresh connection on the same tab resets the region sampleCount to 1.
    const reconnected = foldMonitorSample(
      before,
      { key: "sess-1", sampleCount: 1, values: all(7) },
      60
    );
    expect(reconnected.series.cpu).toEqual([7]);
    expect(reconnected.lastSampleCount).toBe(1);
  });

  it("empties the window when the monitor disconnects (sampleCount 0)", () => {
    const before = foldSequence([
      { key: "sess-1", sampleCount: 1, values: all(10) },
      { key: "sess-1", sampleCount: 2, values: all(20) },
    ]);
    const gone = foldMonitorSample(
      before,
      { key: "sess-1", sampleCount: 0, values: all(null) },
      60
    );
    expect(gone.series.cpu).toEqual([]);
  });

  it("records a gap as a null hole in the series", () => {
    const { series } = foldSequence([
      { key: "sess-1", sampleCount: 1, values: all(10) },
      { key: "sess-1", sampleCount: 2, values: all(null) },
      { key: "sess-1", sampleCount: 3, values: all(30) },
    ]);
    expect(series.cpu).toEqual([10, null, 30]);
  });

  it("stays empty and unchanged while there is no active key", () => {
    const { series, key } = foldSequence([{ key: null, sampleCount: 3, values: all(50) }]);
    expect(key).toBeNull();
    expect(series.cpu).toEqual([]);
  });
});
