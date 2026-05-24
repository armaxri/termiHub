import type { Terminal as XTerm } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";

/**
 * Extract the first quoted or comma-separated family name from a CSS
 * font-family stack. `document.fonts.load()` wants a single family name in
 * its CSS-shorthand argument, not the full fallback chain.
 */
function primaryFontFamily(stack: string): string {
  const first = stack.split(",")[0]?.trim() ?? "";
  return first.replace(/^['"]|['"]$/g, "");
}

/**
 * Pre-load the terminal's primary font, force xterm to re-measure its cell
 * width with the real font metrics, then re-fit.
 *
 * Why all three steps are needed:
 *
 * - Our Nerd Font ships via @font-face with `font-display: swap`, so the
 *   browser only fetches the file when something tries to render with it.
 *   `document.fonts.ready` alone is not sufficient — it only awaits fonts
 *   that have already been requested. We explicitly trigger the request
 *   with `document.fonts.load()`.
 *
 * - xterm.js measures cell width once (by drawing "W" into a canvas) and
 *   caches the result on its internal CharSizeService. The first paint
 *   happens against the fallback monospace, so the cached cell width is
 *   the fallback's. When the real font swaps in, glyphs render with the
 *   new metrics but the cached cell grid stays put — and FitAddon's
 *   reservation is based on the stale grid, so the rightmost column ends
 *   up sitting under the scrollbar slider. Re-assigning the `fontFamily`
 *   option (via a different value and back) forces xterm to re-measure.
 *
 * - After the re-measure we run `FitAddon.fit()` so the column count is
 *   recomputed against the new cell width and `xterm.resize()` propagates
 *   the change to the PTY.
 *
 * `isCanceled` lets the caller bail out if the terminal was torn down
 * while we were waiting (StrictMode mount/unmount, tab close).
 */
export async function refitWhenFontsReady(
  xterm: XTerm,
  fitAddon: FitAddon,
  fontFamily: string,
  fontSize: number,
  isCanceled: () => boolean
): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return;

  const family = primaryFontFamily(fontFamily);
  if (family) {
    try {
      await document.fonts.load(`${fontSize}px "${family}"`);
    } catch {
      // Network/parse error — fall through to fonts.ready as a fallback.
    }
  }

  try {
    await document.fonts.ready;
  } catch {
    return;
  }

  if (isCanceled()) return;

  // Force xterm to re-measure cell width with the now-loaded font. Toggling
  // fontFamily through a sentinel and back trips xterm's option-change
  // detection (same-value assignments are a no-op).
  try {
    const current = xterm.options.fontFamily ?? "";
    xterm.options.fontFamily = "monospace";
    xterm.options.fontFamily = current;
  } catch {
    // Disposed terminal — nothing to do.
    return;
  }

  if (isCanceled()) return;
  try {
    fitAddon.fit();
  } catch {
    // Container might not have dimensions yet; the next ResizeObserver fit
    // will pick up the correct cell width.
  }
}
