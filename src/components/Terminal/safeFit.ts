/**
 * Degenerate-container guard for xterm `FitAddon.fit()` (#2693).
 *
 * A layout op that reparents a terminal — drag-to-edge / drag-to-center /
 * cross-panel move / tab-move-across-groups — moves the terminal's DOM element
 * into a freshly-created (or otherwise not-yet-laid-out) panel slot. Any
 * `fit()` that runs in that window (`TerminalSlot` adopt-time re-fit, the
 * visibility re-fit) measures a ~0-sized container, so `FitAddon.proposeDimensions()`
 * clamps to its ~2 cols × 1 row minimum. Applying that resize to the xterm (and
 * its PTY) reflows the buffer at 2 columns — a **destructive** reflow that
 * mangles the scrollback into 2-column garbage and makes the shell redraw its
 * prompt, so the terminal's history is lost even though the backend session is
 * still alive. That is the real "scrollback lost on drag/move" bug: not a
 * remount and not a new shell, but a fit against an unsized container.
 *
 * The `ResizeObserver` in `Terminal` already skips its own fit below this
 * threshold; this shared guard applies the same floor to every other fit call
 * site so no reparent path can slip a degenerate resize through.
 */

/**
 * Minimum element size, in CSS px on either axis, before a `FitAddon.fit()` is
 * safe to run. Below this the proposed dimensions collapse to xterm's minimum
 * and the resize corrupts the buffer (#2693). Matches the `ResizeObserver`
 * guard in `Terminal`.
 */
export const MIN_FIT_PX = 10;

/**
 * Whether `el` is laid out large enough that fitting it will not compute a
 * degenerate (buffer-corrupting) terminal size. A missing element, or one still
 * parked / mid-reparent at ~0 size, returns `false` so the caller skips the fit
 * and lets the `ResizeObserver` re-fit once real layout dimensions land.
 */
export function isFitReady(el: HTMLElement | null | undefined): boolean {
  if (!el) return false;
  return el.offsetWidth >= MIN_FIT_PX && el.offsetHeight >= MIN_FIT_PX;
}
