/**
 * `useMonitorHistory` — client-side rolling history for a system monitor
 * (PROD-0030, slice 1).
 *
 * The `system-monitors` projection region is authoritative but retains only the
 * *latest* sample per monitor — there is no server-side time series. This hook
 * reconstructs a short rolling window on the client by folding each new sample of
 * the active monitor into a fixed-capacity ring ({@link pushBounded}), so a
 * compact CPU sparkline can be drawn without any backend change.
 *
 * New samples are detected by the monitor's monotonically increasing
 * `sampleCount` (from the region), not by object identity: a paused or stale
 * monitor stops incrementing it, so the window simply *holds* (no synthetic
 * points are invented for the gap). Switching to a different monitor key resets
 * the window so one host's history never bleeds into another's.
 */

import { useEffect, useState } from "react";

import { pushBounded } from "@/utils/ringBuffer";

/** Number of samples retained per monitor (bounded memory). */
export const MONITOR_HISTORY_CAP = 90;

/** Accumulated rolling-history state for a single monitor. */
export interface MonitorHistoryState {
  /** The monitor key this history belongs to, or `null` when idle. */
  key: string | null;
  /** The last `sampleCount` folded in, to detect a genuinely new sample. */
  lastSampleCount: number;
  /** The retained sample values (oldest first); `null` marks a gap. */
  values: (number | null)[];
}

/** The empty history a fresh hook starts from. */
export const initialMonitorHistoryState: MonitorHistoryState = {
  key: null,
  lastSampleCount: 0,
  values: [],
};

/** One monitor observation folded into the rolling history. */
export interface MonitorSampleInput {
  /** Active monitor key, or `null` when none is resolvable. */
  key: string | null;
  /** The monitor's monotonically increasing sample count (from the region). */
  sampleCount: number;
  /** The metric value for this sample, or `null` to record a gap. */
  value: number | null;
}

/**
 * Fold one monitor observation into the rolling history (pure).
 *
 * - A changed `key` (including going to/from `null`) resets the window, seeding
 *   it with the current value when there is a real sample to seed from.
 * - A strictly greater `sampleCount` appends the value (bounded by `capacity`).
 * - Anything else (same/stale count, no key) leaves the window unchanged, so a
 *   paused or stale monitor holds rather than accruing duplicate points.
 */
export function foldMonitorSample(
  state: MonitorHistoryState,
  input: MonitorSampleInput,
  capacity: number = MONITOR_HISTORY_CAP
): MonitorHistoryState {
  if (input.key !== state.key) {
    const seed = input.key != null && input.sampleCount > 0 ? [input.value] : [];
    return { key: input.key, lastSampleCount: input.sampleCount, values: seed.slice(0, capacity) };
  }
  if (input.key == null) return state;
  if (input.sampleCount <= state.lastSampleCount) return state;
  return {
    key: input.key,
    lastSampleCount: input.sampleCount,
    values: pushBounded(state.values, input.value, capacity),
  };
}

/** Options for {@link useMonitorHistory}. */
export interface UseMonitorHistoryOptions {
  /** Active monitor key, or `null` when none is resolvable. */
  key: string | null;
  /** The monitor's sample count (from the region), used to detect new samples. */
  sampleCount: number;
  /** The metric value for the latest sample, or `null` to record a gap. */
  value: number | null;
  /** Samples to retain (defaults to {@link MONITOR_HISTORY_CAP}). */
  capacity?: number;
}

/**
 * Maintain a bounded rolling window of a monitor metric across renders, appending
 * one point per new region sample. Returns the retained values (oldest first),
 * ready to hand to a sparkline.
 */
export function useMonitorHistory({
  key,
  sampleCount,
  value,
  capacity = MONITOR_HISTORY_CAP,
}: UseMonitorHistoryOptions): (number | null)[] {
  const [state, setState] = useState<MonitorHistoryState>(initialMonitorHistoryState);

  useEffect(() => {
    setState((prev) => foldMonitorSample(prev, { key, sampleCount, value }, capacity));
  }, [key, sampleCount, value, capacity]);

  return state.values;
}
