/**
 * Real xterm render-path reads and faults for the test bridge (#2988).
 *
 * jsdom has no layout engine and no canvas, so the measured/painted half of
 * the terminal — `FitAddon.proposeDimensions()`, the renderer's sub-pixel cell
 * width, the WebGL canvas, the DOM renderer's painted rows, the gutter
 * scrollbar's thumb against a laid-out track — cannot be asserted in vitest
 * (see `Terminal.xterm-integration.test.ts`). These helpers expose exactly that
 * state from a real WebView so the Python bridge harness can assert it:
 * `measureTerminal` (read-only) and `loseTerminalWebglContext` (forces a real
 * GPU context loss so the DOM fallback runs).
 */
import type { TerminalHandles } from "@/components/Terminal/TerminalRegistry";
import {
  readRawRenderedCellHeight,
  readRawRenderedCellWidth,
} from "@/components/Terminal/xtermDimensions";
import type {
  TerminalDecoration,
  TerminalMeasurement,
  TerminalPaint,
  TerminalScrollbarMeasurement,
} from "./protocol";

/** The minimal `WEBGL_lose_context` extension surface used here. */
interface LoseContextExtension {
  loseContext(): void;
}

/**
 * The WebGL addon's canvas: it is appended to `.xterm-screen` with no class,
 * unlike the inline-image layer (`xterm-image-layer`). Returns `undefined` when
 * no such canvas is mounted (the DOM renderer is live).
 */
function findWebglCanvas(element: HTMLElement): HTMLCanvasElement | undefined {
  const canvases = element.querySelectorAll<HTMLCanvasElement>(".xterm-screen > canvas");
  return Array.from(canvases).find((canvas) => canvas.classList.length === 0);
}

/** Each row the DOM renderer painted, with its `&nbsp;` padding normalized away. */
function readDomRows(element: HTMLElement): string[] | null {
  const rows = element.querySelector(".xterm-rows");
  if (!rows) return null;
  return Array.from(rows.children).map((row) =>
    (row.textContent ?? "").replace(/\u00a0/g, " ").trimEnd()
  );
}

/** The computed `background-color` of `el` (as the WebView resolves it). */
function backgroundOf(el: Element): string {
  return (el.ownerDocument.defaultView ?? window).getComputedStyle(el).backgroundColor;
}

/**
 * The gutter scrollbar's laid-out track and thumb, or `null` when not mounted.
 * Horizontal geometry is relative to the terminal container's left edge, so a
 * test can check the thumb sits in its own strip, right of the text (#4930).
 */
function measureScrollbar(element: HTMLElement): TerminalScrollbarMeasurement | null {
  const gutter = element.querySelector<HTMLElement>(".terminal-vscroll-gutter");
  const thumb = gutter?.querySelector<HTMLElement>(".terminal-vscroll-thumb");
  if (!gutter || !thumb) return null;
  const thumbVisible = thumb.style.display !== "none" && thumb.style.display !== "";
  const box = element.getBoundingClientRect();
  const track = gutter.getBoundingClientRect();
  const rect = thumb.getBoundingClientRect();
  return {
    trackHeight: gutter.clientHeight,
    thumbVisible,
    thumbHeight: thumbVisible ? rect.height : 0,
    thumbTop: thumbVisible ? rect.top - track.top : 0,
    gutterLeft: track.left - box.left,
    gutterWidth: gutter.clientWidth,
    thumbLeft: thumbVisible ? rect.left - box.left : 0,
    thumbWidth: thumbVisible ? rect.width : 0,
    thumbColor: backgroundOf(thumb),
  };
}

/**
 * Where the text actually paints and what is behind it (#4930): the right
 * edge of the visible text area (the rows' screen, clipped to the scroll
 * viewport in horizontal-scroll mode) and the bottom of the last row, both
 * relative to the container; the container's and xterm theme's background;
 * and, in horizontal-scroll mode, the native horizontal bar's laid-out height.
 */
function measurePaint(element: HTMLElement, xterm: TerminalHandles["xterm"]): TerminalPaint {
  const box = element.getBoundingClientRect();
  const screen = element.querySelector<HTMLElement>(".xterm-screen");
  const viewport = element.querySelector<HTMLElement>(".terminal-scroll-viewport");
  const screenRect = screen?.getBoundingClientRect();
  const viewportRect = viewport?.getBoundingClientRect();
  const horizontal = viewport?.classList.contains("terminal-horizontal-scroll") ?? false;
  const textRight =
    screenRect && viewportRect
      ? Math.min(screenRect.right, viewportRect.left + (viewport?.clientWidth ?? 0)) - box.left
      : null;
  const cellHeight = readRawRenderedCellHeight(xterm) ?? 0;
  return {
    textRight,
    rowsBottom: screenRect ? screenRect.top - box.top + xterm.rows * cellHeight : null,
    containerBackground: backgroundOf(element),
    themeBackground: xterm.options.theme?.background ?? null,
    horizontalScroll: horizontal,
    viewportClientBottom:
      viewport && viewportRect ? viewportRect.top - box.top + viewport.clientHeight : null,
    hscrollBarHeight: viewport && horizontal ? viewport.offsetHeight - viewport.clientHeight : 0,
  };
}

/**
 * Every rendered xterm decoration (#4930): the OSC 133 gutter bars and the
 * jump-to-prompt flash are DOM elements xterm positions over the screen, so
 * their classes, computed colour and rect are what the user sees. Rects are
 * relative to the container's top-left.
 */
function measureDecorations(element: HTMLElement): TerminalDecoration[] {
  const box = element.getBoundingClientRect();
  return Array.from(element.querySelectorAll<HTMLElement>(".xterm-decoration")).map((el) => {
    const rect = el.getBoundingClientRect();
    return {
      classes: Array.from(el.classList),
      background: backgroundOf(el),
      top: rect.top - box.top,
      left: rect.left - box.left,
      width: rect.width,
      height: rect.height,
    };
  });
}

/** Read a registered terminal's real render-path state (`measureTerminal`). */
export function measureTerminal({
  element,
  xterm,
  fitAddon,
}: TerminalHandles): TerminalMeasurement {
  const proposed = fitAddon.proposeDimensions();
  const canvas = findWebglCanvas(element);
  const buffer = xterm.buffer.active;
  return {
    grid: { cols: xterm.cols, rows: xterm.rows },
    proposed:
      proposed && Number.isFinite(proposed.cols) && Number.isFinite(proposed.rows)
        ? { cols: proposed.cols, rows: proposed.rows }
        : null,
    cell: {
      width: readRawRenderedCellWidth(xterm) ?? null,
      height: readRawRenderedCellHeight(xterm) ?? null,
    },
    container: { width: element.clientWidth, height: element.clientHeight },
    renderer: element.dataset.terminalRenderer ?? null,
    webglCanvas: canvas ? { width: canvas.width, height: canvas.height } : null,
    domRows: readDomRows(element),
    scrollbar: measureScrollbar(element),
    paint: measurePaint(element, xterm),
    decorations: measureDecorations(element),
    viewportY: buffer.viewportY,
    baseY: buffer.baseY,
  };
}

/**
 * Lose the WebGL renderer's GPU context through `WEBGL_lose_context`, the same
 * `webglcontextlost` path a driver reset takes. Returns `false` when the
 * terminal has no live WebGL2 context to lose (it is on the DOM renderer).
 *
 * `getContext("webgl2")` on the addon's canvas returns the context the addon
 * already created; it is only called on that unclassed canvas, so it never
 * creates a context on another layer.
 */
export function loseTerminalWebglContext({ element }: TerminalHandles): boolean {
  const canvas = findWebglCanvas(element);
  if (!canvas) return false;
  const gl = canvas.getContext("webgl2");
  if (!gl || gl.isContextLost()) return false;
  const ext = gl.getExtension("WEBGL_lose_context") as LoseContextExtension | null;
  if (!ext) return false;
  ext.loseContext();
  return true;
}
