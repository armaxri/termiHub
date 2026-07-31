import { act } from "react";

/**
 * Resolve on the next event-loop *check* phase via `setImmediate`.
 *
 * This is the shared, deterministic replacement for the `await new Promise((r)
 * => setTimeout(r, 0))` macrotask flush that was previously re-declared in every
 * component and store test. A `setTimeout(…, 0)` macrotask must wait for a real
 * wall-clock timer to fire; on a starved Windows CI runner (coarse ~15ms timer
 * granularity, further delayed under load) that callback can be deferred long
 * enough to trip the 15s per-test timeout — the intermittent flake first seen in
 * `FileBrowser.test.tsx` and tracked in #2282. `setImmediate` instead resolves on
 * the next event-loop check phase, after microtasks and any due timer callbacks,
 * without waiting on the wall clock — so the flush stays deterministic regardless
 * of how loaded the runner is.
 *
 * Use this directly in non-React tests (store/service). React component tests
 * that need the flush wrapped in `act()` should use {@link flushAsync}.
 *
 * @returns A promise that resolves after the current macrotask completes.
 */
export function flushMacrotask(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * Flush pending microtasks (Promise callbacks) and due timer callbacks inside
 * `act()`.
 *
 * The `act()` wrapper keeps React's effect/update scheduling settled so tests do
 * not log "not wrapped in act(...)" warnings. The underlying wait is the
 * deterministic {@link flushMacrotask} rather than a wall-clock `setTimeout(…,
 * 0)`; see that helper for why (#2282).
 *
 * @returns A promise that resolves once the flush has settled.
 */
export async function flushAsync(): Promise<void> {
  await act(async () => {
    await flushMacrotask();
  });
}
