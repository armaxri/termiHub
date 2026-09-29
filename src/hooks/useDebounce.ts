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
  /**
   * Run any pending invocation immediately (no-op if nothing is pending). Runs
   * {@link DebounceOptions.onFlush} instead of the callback when one is given.
   */
  flush: () => void;
}

/**
 * Optional behaviour for {@link useDebouncedCallback}.
 *
 * @typeParam A - the callback's argument tuple.
 */
export interface DebounceOptions<A extends unknown[]> {
  /**
   * A distinct body for an *early* run — `flush()` (and the unmount flush when
   * {@link flushOnUnmount} is set) invoke this with the pending arguments instead
   * of the timer callback. Use it when flushing must do less than a normal fire
   * (e.g. persist without the post-save UI side effects during unmount). Defaults
   * to the callback itself.
   */
  onFlush?: (...args: A) => void;
  /**
   * When `true`, a pending invocation is **flushed** on unmount (through
   * {@link onFlush} if given) instead of dropped — so the last edit of an
   * auto-save is never lost when the owning component goes away. Default `false`
   * (pending work is cancelled on unmount).
   */
  flushOnUnmount?: boolean;
}

/**
 * Debounce a side-effecting callback: the returned function delays the call
 * until `delayMs` has elapsed since the last invocation, always running with the
 * most recent arguments. On unmount the pending timer is always cleared — the
 * queued call is dropped, or run synchronously when `flushOnUnmount` is set — so
 * a timer never fires after the component is gone.
 *
 * The returned function's identity is **stable** across renders (safe to list in
 * effect/`useCallback` dependency arrays), and it always calls the latest
 * `callback` (and `onFlush`) — so an inline closure over changing props works
 * without re-arming. `cancel()` and `flush()` give a hand-rolled `setTimeout` +
 * ref site an exact, cleanup-safe replacement.
 *
 * @typeParam A - the callback's argument tuple.
 * @param callback - the function to invoke after the debounce interval.
 * @param delayMs - the debounce interval in milliseconds.
 * @param options - optional distinct flush body and flush-on-unmount behaviour.
 * @returns a {@link DebouncedCallback} — callable, with `cancel()` and `flush()`.
 */
export function useDebouncedCallback<A extends unknown[]>(
  callback: (...args: A) => void,
  delayMs: number,
  options?: DebounceOptions<A>
): DebouncedCallback<A> {
  const onFlush = options?.onFlush;
  // A single-key view over the keyed debouncer: one pending invocation at most.
  const keyed = useKeyedDebouncedCallback<typeof SINGLE_KEY, A>(
    (_key, ...args) => callback(...args),
    delayMs,
    {
      onFlush: onFlush ? (_key, ...args) => onFlush(...args) : undefined,
      flushOnUnmount: options?.flushOnUnmount,
    }
  );

  return useMemo(
    () =>
      Object.assign((...args: A) => keyed(SINGLE_KEY, ...args), {
        cancel: () => keyed.cancel(SINGLE_KEY),
        flush: () => keyed.flush(SINGLE_KEY),
      }),
    [keyed]
  );
}

/** The one key {@link useDebouncedCallback} uses on its keyed debouncer. */
const SINGLE_KEY = "__single__";

/**
 * A stable, **keyed** debounced function: one independent debounce per key.
 *
 * Calling it with a key (re)arms only that key's timer; other keys' pending
 * invocations are untouched, so e.g. per-plugin auto-saves coalesce
 * independently. `cancel` / `flush` act on one key, or on every pending key when
 * called without one.
 *
 * @typeParam K - the key type.
 * @typeParam A - the callback's argument tuple (after the key).
 */
export interface KeyedDebouncedCallback<K, A extends unknown[]> {
  (key: K, ...args: A): void;
  /** Drop the pending invocation for `key` (or for every key when omitted). */
  cancel: (key?: K) => void;
  /**
   * Run the pending invocation for `key` (or for every key when omitted)
   * immediately, through {@link KeyedDebounceOptions.onFlush} if given.
   */
  flush: (key?: K) => void;
}

/**
 * Optional behaviour for {@link useKeyedDebouncedCallback}; the keyed analogue of
 * {@link DebounceOptions} (the flush body also receives the key).
 */
export interface KeyedDebounceOptions<K, A extends unknown[]> {
  /** Distinct body for an early run (flush / unmount flush). Defaults to the callback. */
  onFlush?: (key: K, ...args: A) => void;
  /** Flush (rather than drop) every pending key on unmount. Default `false`. */
  flushOnUnmount?: boolean;
}

/**
 * Debounce a side-effecting callback **per key**: each key keeps its own timer
 * and its own latest arguments, and `callback(key, ...args)` runs once `delayMs`
 * has elapsed since that key's last call. Every pending timer is cleared on
 * unmount (dropped, or flushed when `flushOnUnmount` is set).
 *
 * Like {@link useDebouncedCallback}, the returned function's identity is stable
 * and it always calls the latest `callback` / `onFlush`.
 *
 * @typeParam K - the key type (compared with `Map` semantics).
 * @typeParam A - the callback's argument tuple (after the key).
 * @param callback - invoked as `callback(key, ...args)` after the interval.
 * @param delayMs - the debounce interval in milliseconds.
 * @param options - optional distinct flush body and flush-on-unmount behaviour.
 * @returns a {@link KeyedDebouncedCallback}.
 */
export function useKeyedDebouncedCallback<K, A extends unknown[]>(
  callback: (key: K, ...args: A) => void,
  delayMs: number,
  options?: KeyedDebounceOptions<K, A>
): KeyedDebouncedCallback<K, A> {
  // Keep the latest callback, flush body, delay and unmount mode in refs so the
  // returned function's identity stays stable even as they change between renders.
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  const onFlushRef = useRef(options?.onFlush);
  onFlushRef.current = options?.onFlush;
  const delayRef = useRef(delayMs);
  delayRef.current = delayMs;
  const flushOnUnmountRef = useRef(options?.flushOnUnmount ?? false);
  flushOnUnmountRef.current = options?.flushOnUnmount ?? false;

  // key → its armed timer and the latest arguments it will run with.
  const pendingRef = useRef<Map<K, { timer: ReturnType<typeof setTimeout>; args: A }>>(new Map());

  /** Remove the given keys (all when omitted), clearing their timers. */
  const take = useCallback((key: K | undefined, all: boolean) => {
    const pending = pendingRef.current;
    const keys = all ? [...pending.keys()] : pending.has(key as K) ? [key as K] : [];
    const taken: Array<[K, A]> = [];
    for (const k of keys) {
      const entry = pending.get(k)!;
      clearTimeout(entry.timer);
      pending.delete(k);
      taken.push([k, entry.args]);
    }
    return taken;
  }, []);

  const cancel = useCallback(
    (...keyArg: [K?]) => {
      take(keyArg[0], keyArg.length === 0);
    },
    [take]
  );

  const flush = useCallback(
    (...keyArg: [K?]) => {
      for (const [k, args] of take(keyArg[0], keyArg.length === 0)) {
        (onFlushRef.current ?? callbackRef.current)(k, ...args);
      }
    },
    [take]
  );

  const debounced = useCallback((key: K, ...args: A) => {
    const pending = pendingRef.current;
    const existing = pending.get(key);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      const entry = pending.get(key);
      if (!entry || entry.timer !== timer) return;
      pending.delete(key);
      callbackRef.current(key, ...entry.args);
    }, delayRef.current);
    pending.set(key, { timer, args });
  }, []);

  // On unmount, never leave a timer behind: flush or drop every pending key.
  useEffect(
    () => () => {
      if (flushOnUnmountRef.current) flush();
      else cancel();
    },
    [flush, cancel]
  );

  return useMemo(
    () =>
      Object.assign(debounced, {
        cancel: cancel as (key?: K) => void,
        flush: flush as (key?: K) => void,
      }),
    [debounced, cancel, flush]
  );
}
