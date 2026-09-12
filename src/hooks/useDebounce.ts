import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Debounce a rapidly-changing value: returns the most recent `value` that has
 * held steady for `delayMs`. Each new `value` (or `delayMs`) restarts the timer,
 * and the pending timer is cleared on unmount, so no stale update fires after the
 * component is gone.
 *
 * Use this for read-only derivations of a fast-changing value (e.g. a debounced
 * search term feeding a filter or a validation query). For firing a *side effect*
 * — a debounced save or validate — reach for {@link useDebouncedCallback}, which
 * also exposes `cancel()` and `flush()`.
 *
 * @typeParam T - the value type.
 * @param value - the source value to debounce.
 * @param delayMs - how long `value` must hold steady before it is surfaced.
 * @returns the debounced value.
 */
export function useDebounce<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);

  return debounced;
}

/**
 * A stable debounced function with imperative controls.
 *
 * Calling it (re)arms a timer that invokes the wrapped callback with the *last*
 * arguments after the delay. {@link DebouncedCallback.cancel} drops any pending
 * invocation; {@link DebouncedCallback.flush} runs it immediately if one is
 * pending.
 *
 * @typeParam A - the callback's argument tuple.
 */
export interface DebouncedCallback<A extends unknown[]> {
  (...args: A): void;
  /** Drop any pending invocation without running it. */
  cancel: () => void;
  /** Run any pending invocation immediately (no-op if nothing is pending). */
  flush: () => void;
}

/**
 * Debounce a side-effecting callback: the returned function delays the call
 * until `delayMs` has elapsed since the last invocation, always running with the
 * most recent arguments. The pending timer is cleared on unmount, so a queued
 * call never fires after the component is gone.
 *
 * The returned function's identity is **stable** across renders (safe to list in
 * effect/`useCallback` dependency arrays), and it always calls the latest
 * `callback` — so an inline closure over changing props works without re-arming.
 * `cancel()` and `flush()` give a hand-rolled `setTimeout` + ref site an exact,
 * cleanup-safe replacement.
 *
 * @typeParam A - the callback's argument tuple.
 * @param callback - the function to invoke after the debounce interval.
 * @param delayMs - the debounce interval in milliseconds.
 * @returns a {@link DebouncedCallback} — callable, with `cancel()` and `flush()`.
 */
export function useDebouncedCallback<A extends unknown[]>(
  callback: (...args: A) => void,
  delayMs: number
): DebouncedCallback<A> {
  // Keep the latest callback and delay in refs so the returned function's
  // identity stays stable even as they change between renders.
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  const delayRef = useRef(delayMs);
  delayRef.current = delayMs;

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingArgsRef = useRef<A | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const cancel = useCallback(() => {
    clearTimer();
    pendingArgsRef.current = null;
  }, [clearTimer]);

  const flush = useCallback(() => {
    clearTimer();
    if (pendingArgsRef.current !== null) {
      const args = pendingArgsRef.current;
      pendingArgsRef.current = null;
      callbackRef.current(...args);
    }
  }, [clearTimer]);

  const debounced = useCallback(
    (...args: A) => {
      pendingArgsRef.current = args;
      clearTimer();
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        const args = pendingArgsRef.current;
        pendingArgsRef.current = null;
        if (args !== null) callbackRef.current(...args);
      }, delayRef.current);
    },
    [clearTimer]
  );

  // Clear any pending invocation when the owning component unmounts.
  useEffect(() => cancel, [cancel]);

  return useMemo(
    () => Object.assign(debounced, { cancel, flush }),
    [debounced, cancel, flush]
  );
}
