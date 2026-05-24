import { describe, it, expect, vi } from "vitest";
import { fitTerminal, SCROLLBAR_RESERVE_PX } from "./fitTerminal";
import type { Terminal as XTerm } from "@xterm/xterm";

interface FakeXTerm {
  cols: number;
  rows: number;
  element: HTMLDivElement | null;
  resize: ReturnType<typeof vi.fn>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _core: any;
}

function makeXterm(opts: {
  parentWidth: number;
  parentHeight: number;
  cellWidth: number;
  cellHeight: number;
  cols?: number;
  rows?: number;
  xtermPadding?: { top?: number; right?: number; bottom?: number; left?: number };
}): FakeXTerm {
  const parent = document.createElement("div");
  parent.style.width = `${opts.parentWidth}px`;
  parent.style.height = `${opts.parentHeight}px`;
  document.body.appendChild(parent);

  const el = document.createElement("div");
  const p = opts.xtermPadding ?? {};
  el.style.paddingTop = `${p.top ?? 0}px`;
  el.style.paddingRight = `${p.right ?? 0}px`;
  el.style.paddingBottom = `${p.bottom ?? 0}px`;
  el.style.paddingLeft = `${p.left ?? 0}px`;
  parent.appendChild(el);

  // jsdom's getComputedStyle returns the inline styles for width/height/padding
  // we set above; that's all fitTerminal reads.
  return {
    cols: opts.cols ?? 80,
    rows: opts.rows ?? 24,
    element: el,
    resize: vi.fn(),
    _core: {
      _renderService: {
        dimensions: { css: { cell: { width: opts.cellWidth, height: opts.cellHeight } } },
      },
    },
  };
}

describe("fitTerminal", () => {
  it("reclaims the extra column FitAddon's 14 px reservation hides", () => {
    // Real ground-truth measurement from the user's app:
    //   parentWidth = 967, cellWidth = 8.5
    //   FitAddon 14: floor((967-14)/8.5) = floor(112.12) = 112 cols
    //   ours     5:  floor((967-5)/8.5)  = floor(113.18) = 113 cols  → +1 column.
    const x = makeXterm({ parentWidth: 967, parentHeight: 400, cellWidth: 8.5, cellHeight: 16 });
    fitTerminal(x as unknown as XTerm);
    expect(x.resize).toHaveBeenCalledTimes(1);
    const [cols] = x.resize.mock.calls[0];
    expect(cols).toBe(113);
  });

  it("does not call resize when the computed dims match xterm's current state", () => {
    const x = makeXterm({
      parentWidth: 800,
      parentHeight: 400,
      cellWidth: 10,
      cellHeight: 16,
      cols: Math.floor((800 - SCROLLBAR_RESERVE_PX) / 10),
      rows: Math.floor(400 / 16),
    });
    fitTerminal(x as unknown as XTerm);
    expect(x.resize).not.toHaveBeenCalled();
  });

  it("subtracts the terminal element's own padding from the available width", () => {
    const x = makeXterm({
      parentWidth: 800,
      parentHeight: 400,
      cellWidth: 10,
      cellHeight: 16,
      xtermPadding: { left: 6, right: 6 },
    });
    fitTerminal(x as unknown as XTerm);
    const [cols] = x.resize.mock.calls[0];
    // (800 - 12 padding - 5 reserve) / 10 = 78.3 → 78
    expect(cols).toBe(78);
  });

  it("enforces minimum dims (2 cols / 1 row) for pathologically small parents", () => {
    const x = makeXterm({ parentWidth: 4, parentHeight: 4, cellWidth: 10, cellHeight: 16 });
    fitTerminal(x as unknown as XTerm);
    const [cols, rows] = x.resize.mock.calls[0];
    expect(cols).toBe(2);
    expect(rows).toBe(1);
  });

  it("no-ops when render-service dimensions aren't ready", () => {
    const x = makeXterm({ parentWidth: 800, parentHeight: 400, cellWidth: 10, cellHeight: 16 });
    x._core._renderService.dimensions.css.cell.width = 0;
    fitTerminal(x as unknown as XTerm);
    expect(x.resize).not.toHaveBeenCalled();
  });

  it("no-ops when the terminal has no parent element", () => {
    const x = makeXterm({ parentWidth: 800, parentHeight: 400, cellWidth: 10, cellHeight: 16 });
    x.element?.remove();
    x.element = null;
    fitTerminal(x as unknown as XTerm);
    expect(x.resize).not.toHaveBeenCalled();
  });
});
