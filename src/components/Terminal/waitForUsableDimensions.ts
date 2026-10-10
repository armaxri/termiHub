import type { Terminal as XTerm } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { isProposedFitSafe, MIN_SAFE_FIT_COLS } from "./safeFit";

/** Columns xterm must reach before a reattach treats its dimensions as usable. */
export const MIN_REATTACH_COLS = MIN_SAFE_FIT_COLS;

/**
 * Wall-clock bound (ms) on the reattach dimension wait. Measured with
 * `Date.now()`, not by counting animation frames, so it elapses even when the
 * window is minimized or occluded and `requestAnimationFrame` never fires
 * (#4381, WA-FE2-008).
 */
export const REATTACH_FIT_TIME_BOUND_MS = 3000;

/**
 * Fallback tick (ms) raced against each `requestAnimationFrame`: when rAF is
 * throttled (WKWebView pauses it for occluded views) the loop still advances on
 * this timer instead of stalling until the window is shown.
 */
export const REATTACH_FRAME_FALLBACK_MS = 100;

/** Resolve on the next animation frame or after `fallbackMs`, whichever is first. */
function nextFrameOrTimeout(fallbackMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    let rafId: number | undefined;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (rafId !== undefined && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(rafId);
      }
      resolve();
    };
    const timer = setTimeout(finish, fallbackMs);
    if (typeof requestAnimationFrame === "function") {
      rafId = requestAnimationFrame(() => finish());
    }
  });
}

/**
 * Wait until the xterm element is sitting in a real slot AND xterm has at least
 * {@link MIN_REATTACH_COLS} columns.
 *
 * The xterm DOM element is shared across slot remounts: TerminalSlot moves
 * it from a 1×1 hidden parking area into a real container and back. If a
 * state update (e.g. persistent-session-state → "attached") fires during
 * reattach setup, the slot can remount and stash the element back into
 * parking for a few hundred milliseconds. Calling fitAddon.fit() while the
 * element is parked resizes xterm to 2×1, and then `xterm.write(buffer)`
 * renders the scrollback at that doll-house width.
 *
 * Strategy: only call fit() once {@link isProposedFitSafe} says the proposed
 * dimensions are non-degenerate — the same guard every other fit site uses
 * since #2700 — so neither parking nor a narrow transitional container can
 * clobber xterm's current cols. Each iteration waits for the next animation
 * frame raced against a {@link REATTACH_FRAME_FALLBACK_MS} timer, and the whole
 * wait is bounded by {@link REATTACH_FIT_TIME_BOUND_MS} of wall-clock time, so
 * a misbehaving slot or a hidden / occluded window (where rAF never fires)
 * cannot hang the reattach. On timeout the buffer is written at whatever
 * dimensions xterm has, and the normal resize path still attempts to rewrap.
 */
export async function waitForUsableDimensions(
  xterm: Pick<XTerm, "cols">,
  fitAddon: Pick<FitAddon, "fit" | "proposeDimensions">,
  isCanceled: () => boolean,
  timeBoundMs: number = REATTACH_FIT_TIME_BOUND_MS
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (isProposedFitSafe(fitAddon)) {
      try {
        fitAddon.fit();
      } catch {
        // Per-tick retry loop: silent so it cannot flood the Log Viewer; the
        // next tick retries (#4520).
      }
      if (xterm.cols >= MIN_REATTACH_COLS) return;
    }
    if (isCanceled()) return;
    if (Date.now() - start >= timeBoundMs) return;
    await nextFrameOrTimeout(REATTACH_FRAME_FALLBACK_MS);
  }
}
