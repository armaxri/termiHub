import { describe, it, expect } from "vitest";
import type { Terminal as XTerm } from "@xterm/xterm";
import {
  computeThumbGeometry,
  dragOffsetToLine,
  createTerminalScrollbar,
  MIN_THUMB_PX,
} from "./terminalScrollbar";

describe("computeThumbGeometry", () => {
  it("hides the thumb when there is no scrollback", () => {
    const geo = computeThumbGeometry({
      viewportY: 0,
      baseY: 0,
      rows: 24,
      trackHeightPx: 240,
    });
    expect(geo.visible).toBe(false);
  });

  it("sizes the thumb proportionally to the visible fraction", () => {
    // 24 visible rows out of 24 + 24 = 48 total → half the track.
    const geo = computeThumbGeometry({
      viewportY: 0,
      baseY: 24,
      rows: 24,
      trackHeightPx: 240,
    });
    expect(geo.visible).toBe(true);
    expect(geo.thumbHeightPx).toBeCloseTo(120, 5);
    expect(geo.thumbTopPx).toBe(0);
  });

  it("pins the thumb to the bottom when scrolled fully down", () => {
    const geo = computeThumbGeometry({
      viewportY: 24,
      baseY: 24,
      rows: 24,
      trackHeightPx: 240,
    });
    // thumb height 120 → max top is 240 - 120 = 120.
    expect(geo.thumbTopPx).toBeCloseTo(120, 5);
  });

  it("places the thumb mid-track at a mid scroll position", () => {
    const geo = computeThumbGeometry({
      viewportY: 12,
      baseY: 24,
      rows: 24,
      trackHeightPx: 240,
    });
    expect(geo.thumbTopPx).toBeCloseTo(60, 5);
  });

  it("never renders a thumb smaller than the minimum, even with huge scrollback", () => {
    const geo = computeThumbGeometry({
      viewportY: 0,
      baseY: 100000,
      rows: 24,
      trackHeightPx: 240,
    });
    expect(geo.thumbHeightPx).toBe(MIN_THUMB_PX);
    expect(geo.visible).toBe(true);
  });

  it("clamps the thumb height to the track height", () => {
    const geo = computeThumbGeometry({
      viewportY: 0,
      baseY: 1,
      rows: 1000,
      trackHeightPx: 240,
    });
    expect(geo.thumbHeightPx).toBeLessThanOrEqual(240);
  });
});

describe("dragOffsetToLine", () => {
  it("maps the top of the track to line 0", () => {
    const line = dragOffsetToLine({
      dragTopPx: 0,
      trackHeightPx: 240,
      thumbHeightPx: 120,
      baseY: 24,
    });
    expect(line).toBe(0);
  });

  it("maps the bottom of the travel range to baseY", () => {
    const line = dragOffsetToLine({
      dragTopPx: 120, // trackHeight - thumbHeight
      trackHeightPx: 240,
      thumbHeightPx: 120,
      baseY: 24,
    });
    expect(line).toBe(24);
  });

  it("clamps out-of-range drag offsets", () => {
    expect(
      dragOffsetToLine({
        dragTopPx: -50,
        trackHeightPx: 240,
        thumbHeightPx: 120,
        baseY: 24,
      })
    ).toBe(0);
    expect(
      dragOffsetToLine({
        dragTopPx: 9999,
        trackHeightPx: 240,
        thumbHeightPx: 120,
        baseY: 24,
      })
    ).toBe(24);
  });

  it("round-trips geometry → drag offset → line", () => {
    const baseY = 80;
    const rows = 24;
    const trackHeightPx = 300;
    for (const viewportY of [0, 10, 40, 60, 80]) {
      const geo = computeThumbGeometry({ viewportY, baseY, rows, trackHeightPx });
      const line = dragOffsetToLine({
        dragTopPx: geo.thumbTopPx,
        trackHeightPx,
        thumbHeightPx: geo.thumbHeightPx,
        baseY,
      });
      expect(line).toBe(viewportY);
    }
  });
});

describe("createTerminalScrollbar thumb visibility during drag", () => {
  /** Minimal xterm stub exposing only the API the scrollbar touches. */
  function fakeXterm(): XTerm {
    const noopDisposable = { dispose: () => {} };
    return {
      rows: 24,
      buffer: { active: { viewportY: 0, baseY: 24 } },
      onScroll: () => noopDisposable,
      onResize: () => noopDisposable,
      onWriteParsed: () => noopDisposable,
      scrollToLine: () => {},
      scrollLines: () => {},
    } as unknown as XTerm;
  }

  /** Build a gutter+thumb wired to a scrollbar controller, mounted in the DOM. */
  function mountScrollbar() {
    const gutter = document.createElement("div");
    const thumb = document.createElement("div");
    thumb.className = "terminal-vscroll-thumb";
    gutter.appendChild(thumb);
    document.body.appendChild(gutter);
    const controller = createTerminalScrollbar({ xterm: fakeXterm(), gutter, thumb });
    return { gutter, thumb, controller };
  }

  const isDragging = (thumb: HTMLElement): boolean =>
    thumb.classList.contains("terminal-vscroll-thumb--dragging");

  it("marks the thumb as dragging on pointerdown and clears it on pointerup", () => {
    const { gutter, thumb, controller } = mountScrollbar();

    // A drag keeps the thumb pinned visible even if the pointer later leaves
    // the terminal (which would otherwise drop the :hover reveal).
    thumb.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientY: 10 }));
    expect(isDragging(thumb)).toBe(true);

    window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientY: 40 }));
    expect(isDragging(thumb)).toBe(false);

    controller.dispose();
    gutter.remove();
  });

  it("clears the dragging flag on dispose (torn down mid-drag)", () => {
    const { gutter, thumb, controller } = mountScrollbar();

    thumb.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientY: 10 }));
    expect(isDragging(thumb)).toBe(true);

    controller.dispose();
    expect(isDragging(thumb)).toBe(false);

    gutter.remove();
  });
});
