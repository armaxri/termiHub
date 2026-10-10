/**
 * Event-driven cancellable sleep (#4381, WA-FE2-005).
 *
 * Replaces `while (Date.now() < deadline) { if (canceled) return; await sleep(100) }`
 * busy-sleep loops: instead of waking every 100 ms to poll a cancel flag, the
 * wait listens for the signal's `abort` event and resolves the moment it fires.
 *
 * Resolves to `true` when the full delay elapsed, or `false` when `signal`
 * aborted first (including when it was already aborted on entry, which resolves
 * on the next microtask without starting a timer). Never rejects, so callers
 * keep their existing `if (signal.aborted) return;` guard after the await.
 */
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
