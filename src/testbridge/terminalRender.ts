/**
 * Real xterm render-path reads and faults for the test bridge (#2988).
 *
 * jsdom has no layout engine and no canvas, so the measured/painted half of
 * the terminal — `FitAddon.proposeDimensions()`, the renderer's sub-pixel cell
 * width, the WebGL canvas, the DOM renderer's painted rows, the gutter
 * scrollbar's thumb against a laid-out track — cannot be asserted in vitest
 * (see `Terminal.xterm-integration.test.ts`). These helpers expose exactly that
 * state from a real WebView so the Python bridge harness can assert it:
 * `measureTerminal` (read-only), `loseTerminalWebglContext` (forces a real
 * GPU context loss so the DOM fallback runs) and `readTerminalWebglFrame`
 * (reads back the pixels the WebGL renderer drew, #4970).
 */
import type { TerminalHandles } from "@/components/Terminal/TerminalRegistry";
import { errorMessage } from "@/utils/errorMessage";
import {
  readCharSize,
  readRawRenderedCellHeight,
  readRawRenderedCellWidth,
} from "@/components/Terminal/xtermDimensions";
import type {
  PageRect,
  TerminalDecoration,
  TerminalMeasurement,
  TerminalPaint,
  TerminalScrollbarMeasurement,
  TerminalWebglFrame,
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

/** Whether a computed colour paints nothing (fully transparent). */
function isTransparent(color: string): boolean {
  return color === "" || color === "transparent" || /^rgba\(.*,\s*0\)$/.test(color);
}

/**
 * The background that actually shows behind `el`: its own computed colour, or
 * the first ancestor's that is not transparent (the registered element is an
 * unpainted wrapper inside the `.terminal-container` that paints the bg).
 */
function paintedBackgroundOf(el: Element): string {
  for (let node: Element | null = el; node; node = node.parentElement) {
    const color = backgroundOf(node);
    if (!isTransparent(color)) return color;
  }
  return backgroundOf(el);
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
    containerBackground: paintedBackgroundOf(element),
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

/** The cell grid's rect in the page, or `null` before xterm has a screen (#4937). */
function measureScreenRect(element: HTMLElement): PageRect | null {
  const screen = element.querySelector<HTMLElement>(".xterm-screen");
  if (!screen) return null;
  const rect = screen.getBoundingClientRect();
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

/**
 * The window region the cell grid can show through (#5065): the viewport,
 * intersected with the padding box of every ancestor whose overflow clips.
 * `null` before xterm has a screen.
 */
function measureVisibleRect(element: HTMLElement): PageRect | null {
  const screen = element.querySelector<HTMLElement>(".xterm-screen");
  if (!screen) return null;
  const view = element.ownerDocument.defaultView ?? window;
  let left = 0;
  let top = 0;
  let right = view.innerWidth;
  let bottom = view.innerHeight;
  for (let node = screen.parentElement; node; node = node.parentElement) {
    const style = view.getComputedStyle(node);
    if (style.overflowX === "visible" && style.overflowY === "visible") continue;
    const rect = node.getBoundingClientRect();
    const innerLeft = rect.left + node.clientLeft;
    const innerTop = rect.top + node.clientTop;
    left = Math.max(left, innerLeft);
    top = Math.max(top, innerTop);
    // clientWidth/Height exclude borders and any classic scrollbar.
    right = Math.min(right, innerLeft + node.clientWidth);
    bottom = Math.min(bottom, innerTop + node.clientHeight);
  }
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/**
 * Right edge (page px) of the glyphs the DOM renderer painted (#5065), or
 * `null` when it is not mounted. Measured with a range over each row's text,
 * so it is where the text ends, not where xterm's cells end.
 */
function measureDomTextRight(element: HTMLElement): number | null {
  const rows = element.querySelector(".xterm-rows");
  if (!rows) return null;
  const range = element.ownerDocument.createRange();
  let right = 0;
  for (const row of Array.from(rows.children)) {
    if (!(row.textContent ?? "").replace(/\u00a0/g, " ").trim()) continue;
    range.selectNodeContents(row);
    for (const rect of Array.from(range.getClientRects())) {
      if (rect.width > 0) right = Math.max(right, rect.right);
    }
  }
  return right;
}

/**
 * The font's character cell measured now, the way xterm's canvas strategy
 * measures it (`measureText("W")`), or `null` without `OffscreenCanvas` /
 * font-bounding-box metrics (xterm then measures with the DOM instead).
 */
function measureCurrentCharCell(
  xterm: TerminalHandles["xterm"]
): { width: number; height: number } | null {
  if (typeof OffscreenCanvas === "undefined") return null;
  const ctx = new OffscreenCanvas(100, 100).getContext("2d");
  if (!ctx) return null;
  ctx.font = `${xterm.options.fontSize}px ${xterm.options.fontFamily}`;
  const metrics = ctx.measureText("W");
  if (!("fontBoundingBoxAscent" in metrics)) return null;
  return {
    width: metrics.width,
    height: metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent,
  };
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
  const view = element.ownerDocument.defaultView ?? window;
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
    screenRect: measureScreenRect(element),
    visibleRect: measureVisibleRect(element),
    domTextRight: measureDomTextRight(element),
    charCell: { measured: readCharSize(xterm) ?? null, current: measureCurrentCharCell(xterm) },
    page: {
      devicePixelRatio: view.devicePixelRatio,
      innerWidth: view.innerWidth,
      innerHeight: view.innerHeight,
    },
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

/** How long `readTerminalWebglFrame` waits for the animation frame it reads in. */
export const WEBGL_READBACK_TIMEOUT_MS = 5000;

/** One copy of the WebGL canvas: backing-store size plus row-major RGB bytes. */
interface CanvasCopy {
  width: number;
  height: number;
  rgb: Uint8Array;
}

/** Base64 of `bytes`, encoded in chunks (`String.fromCharCode` has an arity cap). */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Copy `canvas` (any context type) into a 2D canvas and return its pixels as
 * row-major RGB bytes. Alpha is dropped: the terminal canvas is opaque where
 * it paints and the grades compare against opaque colours.
 */
function copyCanvas(canvas: HTMLCanvasElement): CanvasCopy {
  const { width, height } = canvas;
  const copy = canvas.ownerDocument.createElement("canvas");
  copy.width = width;
  copy.height = height;
  const ctx = copy.getContext("2d");
  if (!ctx) throw new Error("no 2D context to copy the WebGL canvas into");
  ctx.drawImage(canvas, 0, 0);
  const rgba = ctx.getImageData(0, 0, width, height).data;
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    rgb[j] = rgba[i];
    rgb[j + 1] = rgba[i + 1];
    rgb[j + 2] = rgba[i + 2];
  }
  return { width, height, rgb };
}

/** The wire form of a copy. */
function toFrame(copy: CanvasCopy, view: Window): TerminalWebglFrame {
  return {
    width: copy.width,
    height: copy.height,
    devicePixelRatio: view.devicePixelRatio,
    rgb: toBase64(copy.rgb),
  };
}

/**
 * The last frame each terminal's renderer drew on its own, for
 * `repaint: false` reads. Armed on the first such read; from then on every
 * xterm `onRender` (fired right after the renderer drew, inside the same
 * animation frame, while the drawing buffer is still defined) copies the
 * canvas. Test-mode only, and only for terminals a test reads this way.
 */
const naturalFrames = new WeakMap<TerminalHandles["xterm"], { latest: CanvasCopy | null }>();

/**
 * Force a full repaint and copy the canvas in the animation frame it draws in.
 * `xterm.refresh` schedules the renderer's draw on the next animation frame;
 * the copy runs from a callback requested *after* it — the same frame, after
 * the draw, before the browser composites and discards the drawing buffer.
 */
function readRepainted(
  canvas: HTMLCanvasElement,
  xterm: TerminalHandles["xterm"],
  view: Window
): Promise<CanvasCopy> {
  return new Promise((resolve, reject) => {
    const timer = view.setTimeout(
      () =>
        reject(
          new Error(
            `no animation frame within ${WEBGL_READBACK_TIMEOUT_MS} ms (is the window occluded?)`
          )
        ),
      WEBGL_READBACK_TIMEOUT_MS
    );
    xterm.refresh(0, xterm.rows - 1);
    view.requestAnimationFrame(() => {
      view.clearTimeout(timer);
      try {
        resolve(copyCanvas(canvas));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(errorMessage(error)));
      }
    });
  });
}

/**
 * Read back what the terminal's WebGL renderer drew (#4970), or `null` on the
 * DOM renderer. This sees the GPU output in-process, where the hosted macOS
 * runners' window server image (every `screencapture`, `CGWindowListCreateImage`
 * and ScreenCaptureKit path) does not contain the canvas.
 *
 * The addon's context has `preserveDrawingBuffer: false`, so the canvas only
 * holds pixels inside the animation frame that drew them; a copy taken later
 * reads black. So:
 *
 * - `repaint: true` (default) forces a full repaint and copies in that frame;
 * - `repaint: false` returns the last frame the renderer drew *on its own*,
 *   for grades of whether the app itself repainted (after a zoom or a split).
 *   The first such read on a terminal arms the per-render copy and seeds it
 *   with one forced repaint; every later read returns what the renderer drew
 *   since, so a renderer that stops drawing leaves a stale frame behind.
 *
 * Rejects when no animation frame arrives (an occluded, throttled web view).
 */
export async function readTerminalWebglFrame(
  { element, xterm }: TerminalHandles,
  repaint = true
): Promise<TerminalWebglFrame | null> {
  const canvas = findWebglCanvas(element);
  if (!canvas) return null;
  const view = element.ownerDocument.defaultView ?? window;
  if (repaint) return toFrame(await readRepainted(canvas, xterm, view), view);
  let tracked = naturalFrames.get(xterm);
  if (!tracked) {
    const state: { latest: CanvasCopy | null } = { latest: null };
    tracked = state;
    naturalFrames.set(xterm, state);
    xterm.onRender(() => {
      const live = findWebglCanvas(element);
      if (!live) return;
      try {
        state.latest = copyCanvas(live);
      } catch {
        // A copy that fails leaves the previous frame: the read reports it.
      }
    });
    state.latest = await readRepainted(canvas, xterm, view);
  }
  if (!tracked.latest) throw new Error("the WebGL renderer has drawn no frame yet");
  return toFrame(tracked.latest, view);
}
