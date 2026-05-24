import type { Terminal as XTerm } from "@xterm/xterm";

/**
 * Pixels we reserve on the right of the viewport for the scrollbar slider.
 * Must match the visible slider geometry in Terminal.css — the slider sits
 * flush against the right edge at this width (`width: 5px; right: 0`), so
 * the reservation and the slider exactly coincide and there is no empty
 * strip beside the rendered text.
 *
 * The upstream FitAddon hardcodes a 14 px reservation
 * (`options.overviewRuler?.width || 14`), which is right for VS Code's
 * default scrollbar but leaves an empty column-wide gap next to our slim
 * slider — visually indistinguishable from "the last character is hidden".
 * Setting `overviewRuler.width` would lower the reservation but also
 * activates xterm's decoration-ruler renderer, which in practice paints
 * over our slider. So instead we replicate FitAddon's algorithm with our
 * own reservation here, and call this helper in place of `fitAddon.fit()`.
 *
 * Why 5 and not 6/7: `cols = floor((parentW - reserve) / cellWidth)`. With
 * a typical cell width around 8.5 px, every column we want to reclaim
 * needs the reserve to be ≥ 8.5 px smaller. Going below 6 buys us the
 * extra column at common window widths; anything ≥ 7 produces the same
 * column count as the upstream 14 px reservation under floor rounding.
 */
export const SCROLLBAR_RESERVE_PX = 5;

/**
 * Compute the column / row count that fits in the terminal's parent
 * container, reserving `reservedPx` on the right for the scrollbar slider,
 * and call `xterm.resize()` if the count changed.
 *
 * Mirrors `FitAddon.fit()` from `@xterm/addon-fit`, but with our slim
 * scrollbar reservation instead of the hardcoded 14 px default. Reads cell
 * dimensions from xterm's render service the same way FitAddon does.
 */
export function fitTerminal(xterm: XTerm, reservedPx: number = SCROLLBAR_RESERVE_PX): void {
  if (!xterm.element || !xterm.element.parentElement) return;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dims = (xterm as any)._core?._renderService?.dimensions;
  const cellW: number | undefined = dims?.css?.cell?.width;
  const cellH: number | undefined = dims?.css?.cell?.height;
  if (!cellW || !cellH) return;

  const parentStyle = window.getComputedStyle(xterm.element.parentElement);
  const parentH = parseInt(parentStyle.getPropertyValue("height"), 10);
  const parentW = Math.max(0, parseInt(parentStyle.getPropertyValue("width"), 10));

  const xtermStyle = window.getComputedStyle(xterm.element);
  const padX =
    parseInt(xtermStyle.getPropertyValue("padding-left"), 10) +
    parseInt(xtermStyle.getPropertyValue("padding-right"), 10);
  const padY =
    parseInt(xtermStyle.getPropertyValue("padding-top"), 10) +
    parseInt(xtermStyle.getPropertyValue("padding-bottom"), 10);

  const cols = Math.max(2, Math.floor((parentW - padX - reservedPx) / cellW));
  const rows = Math.max(1, Math.floor((parentH - padY) / cellH));

  if (
    Number.isFinite(cols) &&
    Number.isFinite(rows) &&
    (xterm.cols !== cols || xterm.rows !== rows)
  ) {
    xterm.resize(cols, rows);
  }
}
