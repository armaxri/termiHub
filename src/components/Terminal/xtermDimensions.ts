/**
 * Typed adapter over xterm.js's PRIVATE render-service dimensions (FEC-001).
 *
 * The horizontal-scroll layout math in `Terminal` needs the exact sub-pixel
 * cell width the renderer actually uses. That value is not part of xterm's
 * public API: `FitAddon.proposeDimensions()` (the only public source) floors it
 * into an integer `cols` and returns just `{ cols, rows }`, so recomputing the
 * width as `availableWidth / cols` over-estimates it and pushes the scroll
 * target past the scrollbar-free area (see `updateHorizontalScrollWidth`).
 *
 * The width lives on the private path
 * `Terminal._core._renderService.dimensions.css.cell.width`. Rather than drill
 * through it with an inline `as any` in the component (silent failure on any
 * xterm upgrade that renames/restructures these internals), that access is
 * isolated here behind one narrow typed interface, and pinned by
 * `xtermDimensions.test.ts` — which fails LOUDLY in CI if a real xterm instance
 * stops exposing the path, instead of letting horizontal scroll mis-size at
 * runtime with no error.
 */
import type { Terminal as XTerm } from "@xterm/xterm";

/** The private cell-dimension node the renderer keeps in CSS (device-independent) px. */
interface XtermCellDimensions {
  width?: number;
  height?: number;
}

/** Private render dimensions; `css.cell.width` is the renderer's true cell width. */
interface XtermRenderDimensions {
  css?: { cell?: XtermCellDimensions };
}

/** Private render service that owns the current {@link XtermRenderDimensions}. */
interface XtermRenderService {
  dimensions?: XtermRenderDimensions;
}

/** Private core object hung off a public {@link XTerm} as `_core`. */
interface XtermCore {
  _renderService?: XtermRenderService;
}

/** A public terminal viewed through its private `_core` handle. */
interface XtermWithPrivateCore {
  _core?: XtermCore;
}

/**
 * Read the renderer's current CSS cell width from xterm's private render
 * service WITHOUT any positivity guard.
 *
 * Returns the raw number when the private path resolves to one — which may
 * legitimately be `0` before the first real measurement (e.g. under jsdom, or
 * before the terminal is laid out) — or `undefined` when the path is missing,
 * i.e. when an xterm upgrade has restructured these internals. Exposed so the
 * adapter's test can assert the private shape is still intact against a real
 * xterm instance and fail loudly in CI if it changes.
 */
export function readRawRenderedCellWidth(xterm: XTerm): number | undefined {
  const width = (xterm as unknown as XtermWithPrivateCore)._core?._renderService?.dimensions?.css
    ?.cell?.width;
  return typeof width === "number" ? width : undefined;
}

/**
 * The renderer's current CSS cell width in device-independent pixels, or
 * `undefined` when it is unavailable — the terminal has not rendered/measured
 * yet (width `0`), or the private xterm shape changed under an upgrade.
 *
 * This is the exact sub-pixel width `FitAddon` uses internally, so feeding it
 * into the horizontal-scroll target width keeps that target inside the
 * scrollbar-free area.
 */
export function getRenderedCellWidth(xterm: XTerm): number | undefined {
  const width = readRawRenderedCellWidth(xterm);
  return width !== undefined && width > 0 ? width : undefined;
}
