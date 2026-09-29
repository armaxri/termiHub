/**
 * `useMonitorHistory` — rolling metric history for a system monitor
 * (PROD-0030, #3204).
 *
 * **Region-preferred.** The `system-monitors` projection region retains a bounded
 * ring of recent samples per live monitor (`history`, #3204), so a newly-opened
 * window or a remounted status bar draws the existing history immediately. When
 * the caller passes that ring as `regionSamples`, the hook derives its series from
 * it ({@link historiesFromRegionSamples}).
 *
 * **Client-side fallback.** Without a region ring the hook reconstructs a short
 * rolling window on the client by folding each new sample of the active monitor
 * into fixed-capacity rings ({@link pushBounded}), one per tracked metric (CPU,
 * memory, swap, network rx/tx). The fold always runs, so falling back is seamless.
 *
 * New samples are detected by the monitor's monotonically increasing
 * `sampleCount` (from the region), not by object identity: a paused or stale
 * monitor stops incrementing it, so the window simply *holds* (no synthetic
 * points are invented for the gap). Switching to a different monitor key — or a
 * reconnect that resets `sampleCount` — resets the window so one host's history
 * never bleeds into another's and a reconnect is not graphed as continuous.
 */

import { useEffect, useMemo, useState } from "react";

import type { MonitorHistorySample, SystemStats } from "@/types/monitoring";
import { pushBounded } from "@/utils/ringBuffer";

/**
 * Number of samples retained per monitor metric (bounded memory). Equal to the
 * backend ring bound (`MONITOR_HISTORY_CAPACITY` in
 * `src-tauri/src/system_monitor_projection/store.rs`).
 */
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

/**
 * The tracked metric values for one sample (pure). CPU and the network rates
 * report a priming/zero first sample (no prior delta, audit gap G10), so sample
 * #1 is a gap (`null`) for those — matching the "CPU —" placeholder rather than a
 * misleading 0. Memory is correct from the first sample; swap is `null` when the
 * host has no swap so its window stays empty (chart omitted). A metric the sample
 * lists as unavailable (#3202 — e.g. a Docker-stats sample) is a gap too, never a
 * placeholder zero.
 */
export function monitorMetricValues(
  stats: SystemStats | null,
  sampleCount: number
): MonitorMetricValues {
  if (!stats) return { cpu: null, memory: null, swap: null, netRx: null, netTx: null };
  const unavailable = new Set(stats.unavailableMetrics ?? []);
  const primed = sampleCount >= 2;
  const net = primed && !unavailable.has("network");
  return {
    cpu: primed && !unavailable.has("cpu") ? stats.cpuUsagePercent : null,
    memory: unavailable.has("memory") ? null : stats.memoryUsedPercent,
    swap: stats.swapTotalKb > 0 && !unavailable.has("swap") ? stats.swapUsedPercent : null,
    netRx: net ? stats.netRxBytesPerSec : null,
    netTx: net ? stats.netTxBytesPerSec : null,
  };
}

/**
 * Derive the per-metric series from the region's retained ring (pure, #3204):
 * the newest `capacity` samples, oldest first, each mapped through
 * {@link monitorMetricValues} with its own `sampleCount`.
 */
export function historiesFromRegionSamples(
  samples: readonly MonitorHistorySample[],
  capacity: number = MONITOR_HISTORY_CAP
): MonitorHistories {
  const series = emptyMonitorHistories();
  const start = Math.max(0, samples.length - Math.max(0, capacity));
  for (let i = start; i < samples.length; i++) {
    const values = monitorMetricValues(samples[i].stats, samples[i].sampleCount);
    for (const k of MONITOR_METRIC_KEYS) series[k].push(values[k]);
  }
  return series;
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
  /**
   * The region's retained ring for this monitor (#3204). When present it is
   * preferred over the client-side window; `undefined`/`null` falls back to it.
   */
  regionSamples?: readonly MonitorHistorySample[] | null;
}

/**
 * The rolling windows of the monitor metrics: derived from the region's retained
 * ring when `regionSamples` is given, otherwise maintained client-side across
 * renders by appending one point per new region sample. Returns the retained
 * values per metric (oldest first), ready to hand to a sparkline or the history
 * panel.
 */
export function useMonitorHistory({
  key,
  sampleCount,
  values,
  capacity = MONITOR_HISTORY_CAP,
  regionSamples,
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

  // The projection client applies diffs copy-on-write, so a changed ring is a new
  // array and an unchanged one keeps its identity — memoizing on it is exact.
  const regionSeries = useMemo(
    () => (regionSamples ? historiesFromRegionSamples(regionSamples, capacity) : null),
    [regionSamples, capacity]
  );

  return regionSeries ?? state.series;
}
