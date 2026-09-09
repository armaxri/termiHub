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

/**
 * Column floor below which applying a fit is a degenerate, buffer-corrupting
 * reflow (#2700 — the residual second path after #2697).
 *
 * `FitAddon.proposeDimensions()` clamps `cols` to xterm's `MINIMUM_COLS` (2)
 * when the terminal's parent measures ~0 available width, AND it first subtracts
 * a ~14 px overview-ruler/scrollbar reservation from that width. So an element
 * of `MIN_FIT_PX`..~30 px passes {@link isFitReady} (its `offsetWidth` clears the
 * 10 px floor) yet still proposes `cols=2`. During a **cross-panel move** or
 * **drag-to-edge** reparent the destination panel is transiently laid out
 * full-HEIGHT but ~0-WIDTH, so `proposeDimensions()` returns e.g. `cols=2
 * rows=36` — width collapsed, height full. That slips past every element-px
 * guard (the nightly `app.log` shows exactly this `cols=2 rows=<full>` PTY
 * resize on the moved session, sandwiched between healthy `cols=40`/`cols=85`
 * fits), and resizing the xterm/PTY to 2 columns reflows the scrollback into
 * 2-column garbage and makes the shell redraw its prompt — losing history.
 * #2697's `rows=1` parking case (both axes ~0) is the *other* degenerate shape.
 *
 * Guarding on the **proposed** dimensions — the exact value that reaches the
 * PTY — catches every reparent path regardless of which element the px guards
 * measured, and accounts for the scrollbar reservation the px floor ignores.
 * Aligned with `MIN_REATTACH_COLS` in `Terminal.tsx`, which already treats
 * fewer than 20 columns as "not usable dimensions".
 */
export const MIN_SAFE_FIT_COLS = 20;

/**
 * Whether `fitAddon.proposeDimensions()` would compute a non-degenerate size —
 * i.e. applying the fit will not clamp the terminal to xterm's ~2-column floor
 * and destroy the scrollback (#2700). Returns `false` when the container cannot
 * be measured (proposal `undefined` / throws — element detached or mid-reparent)
 * or when the proposed columns fall below {@link MIN_SAFE_FIT_COLS}, so the
 * caller skips the fit and lets a later fit re-run once real dimensions land.
 */
export function isProposedFitSafe(
  fitAddon:
    | { proposeDimensions: () => { cols: number; rows: number } | undefined }
    | null
    | undefined
): boolean {
  if (!fitAddon) return false;
  let dims: { cols: number; rows: number } | undefined;
  try {
    dims = fitAddon.proposeDimensions();
  } catch {
    return false;
  }
  return !!dims && dims.cols >= MIN_SAFE_FIT_COLS && dims.rows >= 1;
}
