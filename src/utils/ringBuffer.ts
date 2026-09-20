/**
 * Bounded rolling-history helpers (PROD-0030).
 *
 * A fixed-capacity ring: appending past the cap drops the oldest sample so
 * memory stays bounded no matter how long a stream runs. Kept as pure functions
 * over plain arrays (rather than a stateful class) so the result is an immutable
 * snapshot React can hold in state and re-render from directly.
 */

/**
 * Append `value` to a bounded history, evicting the oldest entries so the result
 * never exceeds `capacity`. Returns a new array (the input is never mutated).
 *
 * - `capacity <= 0` yields an empty array (nothing is retained).
 * - A `null` value is appended like any other, so callers can record a gap
 *   (a paused/stale interval) as a hole in the series.
 *
 * @param history Current bounded history (oldest first).
 * @param value New sample to append (may be `null` to mark a gap).
 * @param capacity Maximum number of samples to retain.
 */
export function pushBounded<T>(history: readonly T[], value: T, capacity: number): T[] {
  if (capacity <= 0) return [];
  // Keep the newest `capacity - 1` existing samples, then append the new one.
  const start = Math.max(0, history.length - (capacity - 1));
  const next = history.slice(start);
  next.push(value);
  return next;
}
