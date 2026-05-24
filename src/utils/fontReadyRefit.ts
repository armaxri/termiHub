import type { FitAddon } from "@xterm/addon-fit";

/**
 * Re-fit the terminal once custom web fonts finish loading.
 *
 * xterm.js sizes the viewport from the current cell width at the moment
 * `FitAddon.fit()` runs. If the terminal is rendered before our Nerd Font
 * `@font-face` finishes downloading (we use `font-display: swap`), FitAddon
 * computes columns from the fallback monospace's cell width. When the real
 * font swaps in later the cell width changes, content reflows wider than the
 * reserved viewport, and the rightmost column ends up sitting underneath the
 * scrollbar slider — until the user manually resizes the window and triggers
 * a fresh fit.
 *
 * Awaiting `document.fonts.ready` lets us schedule one extra fit after the
 * font load completes. `isCanceled` lets the caller bail out if the terminal
 * was torn down while we were waiting (StrictMode mount/unmount, tab close).
 */
export async function refitWhenFontsReady(
  fitAddon: FitAddon,
  isCanceled: () => boolean
): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return;
  try {
    await document.fonts.ready;
  } catch {
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
