/**
 * Tests for the typed xterm render-service dimensions adapter (FEC-001).
 *
 * The horizontal-scroll layout math needs the exact sub-pixel cell width the
 * renderer uses. That value lives only on xterm's PRIVATE render service
 * (`_core._renderService.dimensions.css.cell.width`) — the public
 * `FitAddon.proposeDimensions()` floors it into an integer `cols` and never
 * exposes the pixel width. `xtermDimensions.ts` isolates that private read
 * behind one typed interface; these tests pin its behaviour AND — crucially —
 * fail LOUDLY in CI if an xterm upgrade restructures the internals, instead of
 * letting horizontal scrolling silently mis-size at runtime.
 */
import { describe, it, expect, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
import {
  getRenderedCellWidth,
  readCharSize,
  readRawRenderedCellWidth,
  remeasureCharSize,
} from "./xtermDimensions";

/** Minimal shape of the private xterm path the adapter reads, for stub building. */
interface CellWidthStub {
  _core?: {
    _renderService?: {
      dimensions?: {
        css?: {
          cell?: { width?: unknown; height?: number };
        };
      };
    };
  };
}

/** Build an xterm-shaped stub whose private cell width is `width`. */
function xtermWithCellWidth(width: unknown): Terminal {
  const stub: CellWidthStub = {
    _core: { _renderService: { dimensions: { css: { cell: { width, height: 17 } } } } },
  };
  return stub as unknown as Terminal;
}

describe("getRenderedCellWidth", () => {
  it("reads the sub-pixel cell width from a realistic xterm-shaped object", () => {
    expect(getRenderedCellWidth(xtermWithCellWidth(8.6015625))).toBe(8.6015625);
  });

  it("returns undefined when the width is zero (not yet measured)", () => {
    expect(getRenderedCellWidth(xtermWithCellWidth(0))).toBeUndefined();
  });

  it("returns undefined when the width is negative or non-numeric", () => {
    expect(getRenderedCellWidth(xtermWithCellWidth(-4))).toBeUndefined();
    expect(getRenderedCellWidth(xtermWithCellWidth("8.6"))).toBeUndefined();
    expect(getRenderedCellWidth(xtermWithCellWidth(undefined))).toBeUndefined();
  });

  it("returns undefined when the private path is absent (shape changed / not opened)", () => {
    expect(getRenderedCellWidth({} as unknown as Terminal)).toBeUndefined();
    const partial: CellWidthStub = { _core: { _renderService: { dimensions: { css: {} } } } };
    expect(getRenderedCellWidth(partial as unknown as Terminal)).toBeUndefined();
  });
});

describe("readRawRenderedCellWidth", () => {
  it("returns the raw numeric width, including a not-yet-measured 0", () => {
    expect(readRawRenderedCellWidth(xtermWithCellWidth(0))).toBe(0);
    expect(readRawRenderedCellWidth(xtermWithCellWidth(9.5))).toBe(9.5);
  });

  it("returns undefined only when the private path does not resolve to a number", () => {
    expect(readRawRenderedCellWidth({} as unknown as Terminal)).toBeUndefined();
    expect(readRawRenderedCellWidth(xtermWithCellWidth("nope"))).toBeUndefined();
  });
});

/**
 * Loud upgrade guard: assert the private path the adapter depends on still
 * resolves to a NUMBER on a REAL xterm instance. Under jsdom nothing is
 * measured, so the width is legitimately `0` — but it must still be a number.
 * If an xterm upgrade renames `_core`/`_renderService` or restructures
 * `dimensions.css.cell`, `readRawRenderedCellWidth` returns `undefined` here and
 * this test fails RED in CI, surfacing the breakage instead of shipping a silent
 * horizontal-scroll regression.
 */
describe("xterm private render-service shape (upgrade guard)", () => {
  it("still exposes a numeric css.cell.width on a real opened xterm instance", () => {
    const term = new Terminal();
    const host = document.createElement("div");
    document.body.appendChild(host);
    term.open(host);
    try {
      expect(typeof readRawRenderedCellWidth(term)).toBe("number");
    } finally {
      term.dispose();
      host.remove();
    }
  });
});

describe("char-size service (#5082)", () => {
  /** An xterm-shaped object whose char-size service measures `next`. */
  function withCharSize(width: number, height: number, next: { width: number; height: number }) {
    const service = {
      width,
      height,
      measure: vi.fn(() => {
        service.width = next.width;
        service.height = next.height;
      }),
    };
    return { term: { _core: { _charSizeService: service } } as unknown as Terminal, service };
  }

  it("reads the measured cell", () => {
    const { term } = withCharSize(8.43, 16, { width: 8.43, height: 16 });
    expect(readCharSize(term)).toEqual({ width: 8.43, height: 16 });
  });

  it("re-measures and reports a changed cell (fallback font → loaded web font)", () => {
    const { term, service } = withCharSize(8.43, 16, { width: 8.43, height: 18 });
    expect(remeasureCharSize(term)).toBe(true);
    expect(service.measure).toHaveBeenCalledTimes(1);
    expect(readCharSize(term)).toEqual({ width: 8.43, height: 18 });
  });

  it("reports an unchanged cell as unchanged", () => {
    const { term } = withCharSize(8.43, 18, { width: 8.43, height: 18 });
    expect(remeasureCharSize(term)).toBe(false);
  });

  it("is a no-op when the private service is missing", () => {
    const term = {} as unknown as Terminal;
    expect(readCharSize(term)).toBeUndefined();
    expect(remeasureCharSize(term)).toBe(false);
  });

  it("still exposes the char-size service on a real opened xterm instance (upgrade guard)", () => {
    const term = new Terminal();
    const host = document.createElement("div");
    document.body.appendChild(host);
    term.open(host);
    try {
      expect(readCharSize(term)).toBeDefined();
      expect(() => remeasureCharSize(term)).not.toThrow();
    } finally {
      term.dispose();
      host.remove();
    }
  });
});
