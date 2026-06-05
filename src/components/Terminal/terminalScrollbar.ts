import type { Terminal as XTerm } from "@xterm/xterm";

/**
 * The terminal's vertical (scrollback) scrollbar — used in both normal and
 * horizontal-scroll modes so the scrollbar looks and behaves identically
 * everywhere. xterm's own overlay scrollbar is hidden; instead we render an
 * always-visible thumb inside a fixed gutter and keep it in sync with the
 * buffer via xterm's public API.
 *
 * This decoupling is required by horizontal-scroll mode: there the `.xterm`
 * element is widened to the full content width and scrolled inside an inner
 * viewport, so xterm's overlay scrollbar (an absolutely-positioned child of the
 * scrolled content) would drift to the content's right edge and only become
 * visible when scrolled fully right. A gutter that sits *beside* the scroll
 * viewport avoids that, and reusing it in normal mode keeps one consistent
 * scrollbar across the app.
 */

/** Minimum thumb height in pixels so the handle stays grabbable with deep scrollback. */
export const MIN_THUMB_PX = 20;

export interface ThumbGeometryInput {
  /** Top line of the viewport within the scrollback buffer (0..baseY). */
  viewportY: number;
  /** Line index of the viewport top when scrolled fully down (total lines - rows). */
  baseY: number;
  /** Number of visible rows. */
  rows: number;
  /** Height of the scrollbar track in pixels. */
  trackHeightPx: number;
}

export interface ThumbGeometry {
  /** Whether the buffer is scrollable and the thumb should be shown. */
  visible: boolean;
  /** Thumb height in pixels. */
  thumbHeightPx: number;
  /** Thumb top offset within the track in pixels. */
  thumbTopPx: number;
}

/**
 * Compute the thumb size and position for the current scroll state.
 * Pure function — no DOM access — so it is unit-testable under jsdom.
 */
export function computeThumbGeometry({
  viewportY,
  baseY,
  rows,
  trackHeightPx,
}: ThumbGeometryInput): ThumbGeometry {
  if (baseY <= 0 || trackHeightPx <= 0) {
    return { visible: false, thumbHeightPx: 0, thumbTopPx: 0 };
  }

  const totalLines = baseY + rows;
  const rawHeight = (trackHeightPx * rows) / totalLines;
  const thumbHeightPx = Math.min(trackHeightPx, Math.max(MIN_THUMB_PX, rawHeight));

  const travel = trackHeightPx - thumbHeightPx;
  const scrollFraction = viewportY / baseY;
  const thumbTopPx = travel > 0 ? travel * scrollFraction : 0;

  return { visible: true, thumbHeightPx, thumbTopPx };
}

export interface DragOffsetInput {
  /** Desired thumb top offset within the track in pixels. */
  dragTopPx: number;
  /** Height of the scrollbar track in pixels. */
  trackHeightPx: number;
  /** Current thumb height in pixels. */
  thumbHeightPx: number;
  /** Line index of the viewport top when scrolled fully down. */
  baseY: number;
}

/**
 * Inverse of {@link computeThumbGeometry}: map a thumb top offset (e.g. from a
 * drag) back to a target scrollback line. Pure function for unit-testability.
 */
export function dragOffsetToLine({
  dragTopPx,
  trackHeightPx,
  thumbHeightPx,
  baseY,
}: DragOffsetInput): number {
  const travel = trackHeightPx - thumbHeightPx;
  const fraction = travel > 0 ? clamp(dragTopPx / travel, 0, 1) : 0;
  return clamp(Math.round(fraction * baseY), 0, baseY);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export interface TerminalScrollbarController {
  /** Re-read the buffer state and re-render the thumb. */
  update(): void;
  /** Remove listeners and reset the thumb. */
  dispose(): void;
}

interface TerminalScrollbarOptions {
  xterm: XTerm;
  /** The fixed gutter element; its height defines the track length. */
  gutter: HTMLElement;
  /** The thumb element rendered inside the gutter. */
  thumb: HTMLElement;
}

/**
 * Wire a {@link TerminalScrollbarController} to an xterm instance: render the
 * thumb on scroll/resize/output and translate thumb drags / track clicks back
 * into buffer scrolling. Touches only the provided gutter/thumb elements and
 * xterm's public API — never xterm's internal DOM.
 */
export function createTerminalScrollbar({
  xterm,
  gutter,
  thumb,
}: TerminalScrollbarOptions): TerminalScrollbarController {
  let disposed = false;
  let rafId: number | null = null;
  // Last rendered thumb geometry, kept so a drag can start from the current
  // position and size without reading them back out of the DOM.
  let thumbTopPx = 0;
  let thumbHeightPx = 0;
  // Drag state captured on pointerdown (layout reads done once per drag).
  let dragStartClientY = 0;
  let dragStartThumbTop = 0;
  let dragTrackHeightPx = 0;
  let dragThumbHeightPx = 0;

  const readGeometry = (): ThumbGeometry => {
    const buffer = xterm.buffer.active;
    return computeThumbGeometry({
      viewportY: buffer.viewportY,
      baseY: buffer.baseY,
      rows: xterm.rows,
      trackHeightPx: gutter.clientHeight,
    });
  };

  const update = (): void => {
    if (disposed) return;
    const geo = readGeometry();
    if (!geo.visible) {
      thumb.style.display = "none";
      return;
    }
    thumbTopPx = geo.thumbTopPx;
    thumbHeightPx = geo.thumbHeightPx;
    thumb.style.display = "block";
    thumb.style.height = `${geo.thumbHeightPx}px`;
    thumb.style.transform = `translateY(${geo.thumbTopPx}px)`;
  };

  // Coalesce frequent triggers (streaming output) into one update per frame.
  const scheduleUpdate = (): void => {
    if (disposed || rafId !== null) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      update();
    });
  };

  const onThumbPointerMove = (e: PointerEvent): void => {
    const desiredTop = dragStartThumbTop + (e.clientY - dragStartClientY);
    const line = dragOffsetToLine({
      dragTopPx: desiredTop,
      trackHeightPx: dragTrackHeightPx,
      thumbHeightPx: dragThumbHeightPx,
      baseY: xterm.buffer.active.baseY,
    });
    xterm.scrollToLine(line);
  };

  const onThumbPointerUp = (e: PointerEvent): void => {
    thumb.releasePointerCapture?.(e.pointerId);
    window.removeEventListener("pointermove", onThumbPointerMove);
    window.removeEventListener("pointerup", onThumbPointerUp);
  };

  const onThumbPointerDown = (e: PointerEvent): void => {
    // Don't let the drag reach the gap-wheel handler or xterm.
    e.preventDefault();
    e.stopPropagation();
    dragStartClientY = e.clientY;
    dragStartThumbTop = thumbTopPx;
    dragTrackHeightPx = gutter.clientHeight;
    dragThumbHeightPx = thumbHeightPx;
    thumb.setPointerCapture?.(e.pointerId);
    window.addEventListener("pointermove", onThumbPointerMove);
    window.addEventListener("pointerup", onThumbPointerUp);
  };

  const onGutterPointerDown = (e: PointerEvent): void => {
    // Click on the track (not the thumb) pages the buffer toward the click.
    if (e.target === thumb) return;
    e.stopPropagation();
    const geo = readGeometry();
    if (!geo.visible) return;
    const clickY = e.clientY - gutter.getBoundingClientRect().top;
    xterm.scrollLines(clickY < geo.thumbTopPx ? -xterm.rows : xterm.rows);
  };

  // onScroll/onResize are infrequent → render immediately. Buffer growth while
  // scrolled up changes the thumb but may not fire onScroll, so also refresh on
  // parsed output (coalesced to one update per frame).
  const scrollDisposable = xterm.onScroll(update);
  const resizeDisposable = xterm.onResize(update);
  const writeParsedDisposable = xterm.onWriteParsed(scheduleUpdate);
  thumb.addEventListener("pointerdown", onThumbPointerDown);
  gutter.addEventListener("pointerdown", onGutterPointerDown);

  update();

  return {
    update,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
      scrollDisposable.dispose();
      resizeDisposable.dispose();
      writeParsedDisposable.dispose();
      thumb.removeEventListener("pointerdown", onThumbPointerDown);
      gutter.removeEventListener("pointerdown", onGutterPointerDown);
      window.removeEventListener("pointermove", onThumbPointerMove);
      window.removeEventListener("pointerup", onThumbPointerUp);
      thumb.style.display = "none";
      thumb.style.transform = "";
    },
  };
}
