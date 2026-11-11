/**
 * Sizing the horizontal-scroll bottom reserve from the real scrollbar (#5280).
 *
 * In horizontal-scroll mode `.xterm` reserves a strip under the last row
 * (`padding-bottom: calc(var(--hscroll-bar) + var(--spacing-xs))`) so the
 * horizontal bar never covers text. The strip only works if `--hscroll-bar` is
 * the height the engine actually gives the bar, and that height is not ours to
 * pin everywhere:
 *
 * - WebView2 (Chromium 121+) ignores every `::-webkit-scrollbar` rule on an
 *   element whose `scrollbar-width` or `scrollbar-color` is not `auto`, and the
 *   global `* { scrollbar-width: thin }` rule sets both. The bar is Chromium's
 *   own thin bar (11 px in Chromium 156 with classic scrollbars, where the
 *   `::-webkit-scrollbar` pin alone gives 10 px).
 * - WKWebView (macOS) with the standard properties (WebKit 18.2+) does the
 *   same: the CI runner measured a 13 px classic bar, not the 10 px the pin
 *   asked for. With overlay scrollbars ("Show scroll bars: automatically" and no
 *   mouse) the bar takes no layout space at all.
 * - WebKitGTK builds without the standard properties still size the bar from
 *   `::-webkit-scrollbar { height }`; with GTK overlay scrollbars it again takes
 *   no layout space.
 *
 * So the terminal measures the bar instead: a hidden probe with the same
 * classes and an always-on horizontal bar (`overflow-x: scroll`) reports
 * `offsetHeight - clientHeight`, and the container's `--hscroll-bar` is set to
 * that. An overlay bar (0) or an implausible reading (an unlaid-out probe)
 * leaves the CSS default, which is the pinned height. The probe stays mounted
 * so a ResizeObserver on it sees the bar change (a mouse plugged in turns
 * overlay bars into classic ones): its content box shrinks or grows with the
 * bar.
 */

/** Class of the hidden probe (styled in Terminal.css). */
export const HSCROLL_PROBE_CLASS = "terminal-hscroll-probe";

/** Readings above this are not a scrollbar (e.g. a probe that was never laid out). */
const MAX_PLAUSIBLE_BAR_PX = 32;

/** Create the probe. The caller appends it to the terminal container. */
export function createHscrollProbe(doc: Document = document): HTMLDivElement {
  const probe = doc.createElement("div");
  probe.className = HSCROLL_PROBE_CLASS;
  probe.setAttribute("aria-hidden", "true");
  return probe;
}

/**
 * The probe's laid-out horizontal-bar height in CSS px, or `null` when the bar
 * takes no layout space (overlay scrollbars) or the reading is implausible.
 */
export function measureHscrollBar(probe: HTMLElement): number | null {
  const bar = probe.offsetHeight - probe.clientHeight;
  if (!Number.isFinite(bar) || bar <= 0 || bar > MAX_PLAUSIBLE_BAR_PX) return null;
  return bar;
}

/**
 * Set the container's `--hscroll-bar` from the probe (or clear it back to the
 * CSS default). Returns whether the value changed, so the caller knows to
 * re-fit the rows.
 */
export function syncHscrollBar(container: HTMLElement, probe: HTMLElement): boolean {
  const bar = measureHscrollBar(probe);
  const next = bar === null ? "" : `${bar}px`;
  const prev = container.style.getPropertyValue("--hscroll-bar");
  if (prev === next) return false;
  if (next) container.style.setProperty("--hscroll-bar", next);
  else container.style.removeProperty("--hscroll-bar");
  return true;
}
