/**
 * Smoothed byte-rate (throughput) and ETA math shared by the live readouts
 * (PROD-038): tunnel up/down rates and the Transfer Queue's per-row fallback
 * and overall footer.
 *
 * The rate is a **time-weighted exponential moving average** over cumulative
 * byte-counter samples taken on a monotonic clock:
 *
 * ```text
 * instant = Δbytes / Δt
 * alpha   = 1 - exp(-Δt / τ)          // weight grows with the sample's span
 * rate    = alpha · instant + (1 - alpha) · rate_prev
 * ```
 *
 * Weighting by elapsed time (rather than a fixed per-sample alpha) is what makes
 * it robust to uneven event timing: a burst of events a few milliseconds apart
 * carries almost no weight each, while a long quiet gap (a stall) pulls the rate
 * down proportionally. Samples closer together than {@link MIN_RATE_SAMPLE_MS}
 * are coalesced into the next one, and a counter that goes *backwards* (a
 * restarted tunnel, a retried transfer) reseeds the estimator instead of
 * producing a negative rate.
 *
 * Everything here is pure and clock-injected so it is deterministic under test.
 */

/** Smoothing time constant τ in ms — ~3 s balances steadiness vs. response. */
export const RATE_TAU_MS = 3000;

/** Samples closer together than this are coalesced into the next sample. */
export const MIN_RATE_SAMPLE_MS = 200;

/** Rates below this (bytes/sec) are reported as idle (`0`) to avoid a long tail. */
export const IDLE_RATE_FLOOR = 1;

/** Estimator state carried between samples. */
export interface RateEstimate {
  /** Cumulative byte counter at the last accepted sample. */
  lastBytes: number;
  /** Monotonic timestamp (ms) of the last accepted sample. */
  lastAt: number;
  /** Smoothed bytes/sec, or `null` until two samples have been seen. */
  rate: number | null;
}

/**
 * Blend one interval's instantaneous throughput into a previous smoothed rate
 * with a time-weighted EMA. `prevRate == null` seeds with the instantaneous
 * value. Returns `prevRate` unchanged for a non-positive interval or a negative
 * byte delta (nothing meaningful to learn from).
 */
export function blendRate(
  prevRate: number | null,
  deltaBytes: number,
  deltaMs: number,
  tauMs: number = RATE_TAU_MS
): number | null {
  if (!(deltaMs > 0) || !(deltaBytes >= 0)) return prevRate;
  const instant = (deltaBytes / deltaMs) * 1000;
  if (prevRate == null || !Number.isFinite(prevRate)) return instant;
  const alpha = 1 - Math.exp(-deltaMs / Math.max(1, tauMs));
  const blended = alpha * instant + (1 - alpha) * prevRate;
  return blended < IDLE_RATE_FLOOR ? 0 : blended;
}

/**
 * Feed a cumulative byte-counter sample taken at monotonic time `at` (ms).
 *
 * - First sample (`prev == null`) seeds the estimator; the rate stays `null`.
 * - A sample less than {@link MIN_RATE_SAMPLE_MS} after the last accepted one
 *   is coalesced (the state is returned unchanged; its bytes land in the next
 *   accepted delta), so bursty event streams do not skew the estimate.
 * - A counter lower than the last one means the source restarted → reseed.
 */
export function sampleRate(
  prev: RateEstimate | null,
  bytes: number,
  at: number,
  tauMs: number = RATE_TAU_MS
): RateEstimate {
  if (!Number.isFinite(bytes) || !Number.isFinite(at)) {
    return prev ?? { lastBytes: 0, lastAt: 0, rate: null };
  }
  if (prev == null || bytes < prev.lastBytes || at < prev.lastAt) {
    return { lastBytes: bytes, lastAt: at, rate: null };
  }
  const deltaMs = at - prev.lastAt;
  if (deltaMs < MIN_RATE_SAMPLE_MS) return prev;
  return {
    lastBytes: bytes,
    lastAt: at,
    rate: blendRate(prev.rate, bytes - prev.lastBytes, deltaMs, tauMs),
  };
}

/**
 * Seconds remaining to move `remainingBytes` at `bytesPerSec`, rounded up.
 * `null` when it cannot be known: unknown remaining, unknown/zero rate.
 * `0` when nothing remains.
 */
export function etaFromRate(
  remainingBytes: number | null | undefined,
  bytesPerSec: number | null | undefined
): number | null {
  if (remainingBytes == null || !Number.isFinite(remainingBytes)) return null;
  if (remainingBytes <= 0) return 0;
  if (bytesPerSec == null || !Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return null;
  return Math.ceil(remainingBytes / bytesPerSec);
}
