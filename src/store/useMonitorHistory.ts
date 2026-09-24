/**
 * `useMonitorHistory` — client-side rolling history for a system monitor
 * (PROD-0030).
 *
 * The `system-monitors` projection region is authoritative but retains only the
 * *latest* sample per monitor — there is no server-side time series. This hook
 * reconstructs a short rolling window on the client by folding each new sample of
 * the active monitor into fixed-capacity rings ({@link pushBounded}), one per
 * tracked metric (CPU, memory, swap, network rx/tx), so compact sparklines and a
 * history panel can be drawn without any backend change.
 *
 * New samples are detected by the monitor's monotonically increasing
 * `sampleCount` (from the region), not by object identity: a paused or stale
 * monitor stops incrementing it, so the window simply *holds* (no synthetic
 * points are invented for the gap). Switching to a different monitor key — or a
 * reconnect that resets `sampleCount` — resets the window so one host's history
 * never bleeds into another's and a reconnect is not graphed as continuous.
 */

import { useEffect, useState } from "react";

import { pushBounded } from "@/utils/ringBuffer";

/** Number of samples retained per monitor metric (bounded memory). */
export const MONITOR_HISTORY_CAP = 90;

/** The system-metric series tracked for history. */
export const MONITOR_METRIC_KEYS = ["cpu", "memory", "swap", "netRx", "netTx"] as const;

/** A single tracked metric. */
export type MonitorMetricKey = (typeof MONITOR_METRIC_KEYS)[number];

/** One value per tracked metric for a single sample; `null` marks a gap. */
export type MonitorMetricValues = Record<MonitorMetricKey, number | null>;

/** Retained rolling history per metric (oldest first); `null` entries are gaps. */
export type MonitorHistories = Record<MonitorMetricKey, (number | null)[]>;

/** A fresh, empty history for every tracked metric. */
export function emptyMonitorHistories(): MonitorHistories {
  return { cpu: [], memory: [], swap: [], netRx: [], netTx: [] };
}

/** Accumulated rolling-history state for a single monitor. */
export interface MonitorHistoryState {
  /** The monitor key this history belongs to, or `null` when idle. */
  key: string | null;
  /** The last `sampleCount` folded in, to detect a genuinely new sample. */
  lastSampleCount: number;
  /** The retained per-metric windows (oldest first); `null` marks a gap. */
  series: MonitorHistories;
}

/** The empty history a fresh hook starts from. */
export const initialMonitorHistoryState: MonitorHistoryState = {
  key: null,
  lastSampleCount: 0,
  series: emptyMonitorHistories(),
};

/** One monitor observation folded into the rolling history. */
export interface MonitorSampleInput {
  /** Active monitor key, or `null` when none is resolvable. */
  key: string | null;
  /** The monitor's monotonically increasing sample count (from the region). */
  sampleCount: number;
  /** The per-metric values for this sample; `null` marks a gap for that metric. */
  values: MonitorMetricValues;
}

/** Seed each metric window from a single sample (bounded by capacity). */
function seedSeries(values: MonitorMetricValues, capacity: number): MonitorHistories {
  const series = emptyMonitorHistories();
  if (capacity > 0) {
    for (const k of MONITOR_METRIC_KEYS) series[k] = [values[k]];
  }
  return series;
}

/**
 * Fold one monitor observation into the rolling history (pure).
 *
 * - A changed `key` (including going to/from `null`) resets the window, seeding
 *   it with the current sample when there is a real one to seed from.
 * - A `sampleCount` that went *backwards* means the monitor reconnected with a
 *   fresh session (disconnect resets the count to `0`); the window resets rather
 *   than graphing across the gap as continuous.
 * - A strictly greater `sampleCount` appends each metric value (bounded by
 *   `capacity`).
 * - Anything else (same/stale count, no key) leaves the window unchanged, so a
 *   paused or stale monitor holds rather than accruing duplicate points.
 */
export function foldMonitorSample(
  state: MonitorHistoryState,
  input: MonitorSampleInput,
  capacity: number = MONITOR_HISTORY_CAP
): MonitorHistoryState {
  if (input.key !== state.key) {
    const seed = input.key != null && input.sampleCount > 0;
    return {
      key: input.key,
      lastSampleCount: input.sampleCount,
      series: seed ? seedSeries(input.values, capacity) : emptyMonitorHistories(),
    };
  }
  if (input.key == null) return state;
  if (input.sampleCount < state.lastSampleCount) {
    // Reconnect / fresh session — reset the window, seeding from this sample.
    return {
      key: input.key,
      lastSampleCount: input.sampleCount,
      series: input.sampleCount > 0 ? seedSeries(input.values, capacity) : emptyMonitorHistories(),
    };
  }
  if (input.sampleCount === state.lastSampleCount) return state;
  const series = emptyMonitorHistories();
  for (const k of MONITOR_METRIC_KEYS) {
    series[k] = pushBounded(state.series[k], input.values[k], capacity);
  }
  return { key: input.key, lastSampleCount: input.sampleCount, series };
}

/** Options for {@link useMonitorHistory}. */
export interface UseMonitorHistoryOptions {
  /** Active monitor key, or `null` when none is resolvable. */
  key: string | null;
  /** The monitor's sample count (from the region), used to detect new samples. */
  sampleCount: number;
  /** The per-metric values for the latest sample; `null` marks a gap. */
  values: MonitorMetricValues;
  /** Samples to retain per metric (defaults to {@link MONITOR_HISTORY_CAP}). */
  capacity?: number;
}

/**
 * Maintain bounded rolling windows of the monitor metrics across renders,
 * appending one point per new region sample. Returns the retained values per
 * metric (oldest first), ready to hand to a sparkline or the history panel.
 */
export function useMonitorHistory({
  key,
  sampleCount,
  values,
  capacity = MONITOR_HISTORY_CAP,
}: UseMonitorHistoryOptions): MonitorHistories {
  const [state, setState] = useState<MonitorHistoryState>(initialMonitorHistoryState);

  // Depend on the individual metric scalars rather than the `values` object so a
  // fresh object literal each render never re-runs the fold on its own (the
  // `sampleCount` gate would hold anyway, but this keeps the effect honest).
  const { cpu, memory, swap, netRx, netTx } = values;
  useEffect(() => {
    setState((prev) =>
      foldMonitorSample(
        prev,
        { key, sampleCount, values: { cpu, memory, swap, netRx, netTx } },
        capacity
      )
    );
  }, [key, sampleCount, cpu, memory, swap, netRx, netTx, capacity]);

  return state.series;
}
