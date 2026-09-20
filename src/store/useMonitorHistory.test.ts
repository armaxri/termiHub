import { describe, it, expect } from "vitest";
import {
  foldMonitorSample,
  initialMonitorHistoryState,
  MONITOR_HISTORY_CAP,
  type MonitorHistoryState,
} from "./useMonitorHistory";

/** Feed a run of samples through the fold, returning the final values. */
function foldSequence(
  inputs: { key: string | null; sampleCount: number; value: number | null }[],
  capacity = MONITOR_HISTORY_CAP
): MonitorHistoryState {
  return inputs.reduce(
    (state, input) => foldMonitorSample(state, input, capacity),
    initialMonitorHistoryState
  );
}

describe("foldMonitorSample", () => {
  it("produces N points from N distinct samples", () => {
    const inputs = Array.from({ length: 5 }, (_, i) => ({
      key: "sess-1",
      sampleCount: i + 1,
      value: (i + 1) * 10,
    }));
    const { values } = foldSequence(inputs);
    expect(values).toEqual([10, 20, 30, 40, 50]);
  });

  it("caps the window and evicts oldest across a long stream", () => {
    const inputs = Array.from({ length: 200 }, (_, i) => ({
      key: "sess-1",
      sampleCount: i + 1,
      value: i + 1,
    }));
    const { values } = foldSequence(inputs, 60);
    expect(values).toHaveLength(60);
    expect(values[0]).toBe(141);
    expect(values[values.length - 1]).toBe(200);
  });

  it("ignores a repeated sample count so paused/stale holds rather than duplicates", () => {
    const { values } = foldSequence([
      { key: "sess-1", sampleCount: 1, value: 10 },
      { key: "sess-1", sampleCount: 2, value: 20 },
      // Same count re-delivered (a re-render with no new sample): no new point.
      { key: "sess-1", sampleCount: 2, value: 20 },
      { key: "sess-1", sampleCount: 2, value: 20 },
    ]);
    expect(values).toEqual([10, 20]);
  });

  it("resets the window when the monitor key changes", () => {
    const first = foldSequence([
      { key: "sess-1", sampleCount: 1, value: 10 },
      { key: "sess-1", sampleCount: 2, value: 20 },
    ]);
    const switched = foldMonitorSample(first, { key: "sess-2", sampleCount: 4, value: 99 }, 60);
    expect(switched.key).toBe("sess-2");
    expect(switched.values).toEqual([99]);
  });

  it("records a gap as a null hole in the series", () => {
    const { values } = foldSequence([
      { key: "sess-1", sampleCount: 1, value: 10 },
      { key: "sess-1", sampleCount: 2, value: null },
      { key: "sess-1", sampleCount: 3, value: 30 },
    ]);
    expect(values).toEqual([10, null, 30]);
  });

  it("stays empty and unchanged while there is no active key", () => {
    const { values, key } = foldSequence([{ key: null, sampleCount: 3, value: 50 }]);
    expect(key).toBeNull();
    expect(values).toEqual([]);
  });
});
