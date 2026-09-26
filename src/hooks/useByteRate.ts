import { useEffect, useRef, useState } from "react";
import { sampleRate, type RateEstimate } from "@/utils/byteRate";

/** How often the cumulative counter is sampled, in ms. */
export const BYTE_RATE_SAMPLE_MS = 1000;

/** Monotonic clock used for rate sampling (never jumps with wall-clock changes). */
function monotonicNow(): number {
  return performance.now();
}

/**
 * Live, smoothed bytes/sec derived from a **cumulative** byte counter
 * (PROD-038) — e.g. a tunnel's `bytesSent` total.
 *
 * The counter is sampled on a fixed {@link BYTE_RATE_SAMPLE_MS} tick against a
 * monotonic clock rather than on every update, so the estimate is independent
 * of how often (or how burstily) the counter changes, and it decays toward zero
 * when the counter stops moving even if no further updates arrive. The math is
 * the time-weighted EMA in {@link sampleRate}; a counter that goes backwards
 * (the source restarted) reseeds it.
 *
 * Returns `null` until two samples have been taken, and whenever `enabled` is
 * false (the estimator is reset, so re-enabling starts fresh).
 *
 * @param bytes   The latest cumulative byte count (`null`/`undefined` = unknown).
 * @param enabled Whether to sample at all (e.g. the tunnel is connected).
 * @param now     Monotonic clock in ms — injectable for tests.
 */
export function useByteRate(
  bytes: number | null | undefined,
  enabled: boolean,
  now: () => number = monotonicNow
): number | null {
  const [rate, setRate] = useState<number | null>(null);
  const bytesRef = useRef(bytes);
  bytesRef.current = bytes;
  const nowRef = useRef(now);
  nowRef.current = now;

  useEffect(() => {
    if (!enabled) {
      setRate(null);
      return;
    }
    let estimate: RateEstimate | null = null;
    const tick = () => {
      const current = bytesRef.current;
      if (current == null) return;
      estimate = sampleRate(estimate, current, nowRef.current());
      setRate(estimate.rate);
    };
    tick();
    const id = setInterval(tick, BYTE_RATE_SAMPLE_MS);
    return () => {
      clearInterval(id);
    };
  }, [enabled]);

  return enabled ? rate : null;
}
