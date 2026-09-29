import { describe, it, expect, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  foldMonitorSample,
  historiesFromRegionSamples,
  initialMonitorHistoryState,
  monitorMetricValues,
  MONITOR_HISTORY_CAP,
  useMonitorHistory,
  type MonitorHistories,
  type MonitorHistoryState,
  type MonitorMetricValues,
  type UseMonitorHistoryOptions,
} from "./useMonitorHistory";
import type { MonitorHistorySample, SystemStats } from "@/types/monitoring";
import { fakeStats } from "@/test/systemMonitorHarness";

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

/** A region history sample: the Nth sample on the connection with a given CPU. */
function regionSample(
  sampleCount: number,
  cpu: number,
  overrides: Partial<SystemStats> = {}
): MonitorHistorySample {
  return { sampleCount, stats: { ...fakeStats("host", cpu), ...overrides } };
}

describe("monitorMetricValues", () => {
  it("records the priming first sample as a gap for CPU and network", () => {
    const values = monitorMetricValues(fakeStats("h", 40), 1);
    expect(values.cpu).toBeNull();
    expect(values.netRx).toBeNull();
    expect(values.netTx).toBeNull();
    expect(values.memory).toBe(50);
    expect(values.swap).toBe(25);
  });

  it("reports every metric once primed", () => {
    const values = monitorMetricValues(fakeStats("h", 40), 2);
    expect(values).toEqual({ cpu: 40, memory: 50, swap: 25, netRx: 1024, netTx: 512 });
  });

  it("leaves swap empty on a host without swap", () => {
    expect(monitorMetricValues({ ...fakeStats("h"), swapTotalKb: 0 }, 3).swap).toBeNull();
  });

  it("renders a metric the sample could not supply as a gap, not a zero", () => {
    const values = monitorMetricValues(
      { ...fakeStats("h", 0), source: "dockerStats", unavailableMetrics: ["cpu", "network"] },
      5
    );
    expect(values.cpu).toBeNull();
    expect(values.netRx).toBeNull();
    expect(values.netTx).toBeNull();
    expect(values.memory).toBe(50);
  });

  it("is all gaps without stats", () => {
    expect(monitorMetricValues(null, 4)).toEqual(all(null));
  });
});

describe("historiesFromRegionSamples", () => {
  it("maps the retained ring to per-metric series, oldest first", () => {
    const series = historiesFromRegionSamples([
      regionSample(1, 10),
      regionSample(2, 20),
      regionSample(3, 30),
    ]);
    // Sample #1 is the priming sample, so CPU starts with a gap.
    expect(series.cpu).toEqual([null, 20, 30]);
    expect(series.memory).toEqual([50, 50, 50]);
  });

  it("keeps only the newest `capacity` samples", () => {
    const samples = Array.from({ length: 6 }, (_, i) => regionSample(i + 1, (i + 1) * 10));
    expect(historiesFromRegionSamples(samples, 3).cpu).toEqual([40, 50, 60]);
  });

  it("is empty for an empty ring", () => {
    expect(historiesFromRegionSamples([])).toEqual({
      cpu: [],
      memory: [],
      swap: [],
      netRx: [],
      netTx: [],
    });
  });
});

describe("useMonitorHistory (region-preferred)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: MonitorHistories;

  // `key` is reserved by React, so the options travel under one prop.
  function Probe({ opts }: { opts: UseMonitorHistoryOptions }) {
    latest = useMonitorHistory(opts);
    return null;
  }

  async function render(opts: UseMonitorHistoryOptions) {
    // The client fold runs in an effect; an async act flushes it before reading.
    await act(async () => {
      root.render(React.createElement(Probe, { opts }));
    });
  }

  function mount() {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows the region's retained history on first render (a remount / new window)", async () => {
    mount();
    await render({
      key: "sess-1",
      sampleCount: 4,
      values: all(99),
      regionSamples: [
        regionSample(1, 10),
        regionSample(2, 20),
        regionSample(3, 30),
        regionSample(4, 40),
      ],
    });
    // The client-side window would hold a single seeded point (99); the region
    // supplies the whole retained history instead.
    expect(latest.cpu).toEqual([null, 20, 30, 40]);
  });

  it("prefers the region over the local window as samples arrive", async () => {
    mount();
    const ring = [regionSample(1, 10), regionSample(2, 20)];
    await render({ key: "sess-1", sampleCount: 2, values: all(1), regionSamples: ring });
    await render({
      key: "sess-1",
      sampleCount: 3,
      values: all(2),
      regionSamples: [...ring, regionSample(3, 30)],
    });
    expect(latest.cpu).toEqual([null, 20, 30]);
  });

  it("falls back to the client-side window when the region has no history", async () => {
    mount();
    await render({ key: "sess-1", sampleCount: 1, values: all(5), regionSamples: undefined });
    await render({ key: "sess-1", sampleCount: 2, values: all(6), regionSamples: undefined });
    expect(latest.cpu).toEqual([5, 6]);
  });
});
