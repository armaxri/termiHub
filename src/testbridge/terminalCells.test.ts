/**
 * xterm glyph layout per PR (#3059): the `readTerminalCells` reader driven
 * against the REAL `@xterm/xterm` with the app's Unicode 11 width tables
 * (`Unicode11Addon`, `unicode.activeVersion = "11"`, as `Terminal.tsx` wires
 * them). These pin the buffer cell model the renderer paints from: CJK
 * characters as one wide cell plus a spacer, combining marks attached to their
 * base, RTL text stored in logical order, emoji ZWJ sequences with every joiner
 * kept on its emoji. The same model is asserted in a real WebView by
 * `tests/system/tests/test_terminal_glyph_shaping.py` (nightly), which also
 * captures a screenshot for visual review.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Terminal as XTerm } from "@xterm/xterm";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { readTerminalCells } from "./terminalCells";
import type { TerminalCell } from "./protocol";

const ZWJ = "‍";

/** Resolve once xterm has parsed `data`. */
function write(term: XTerm, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, () => resolve()));
}

/** `[chars, width]` pairs — compact to compare. */
function layout(cells: TerminalCell[]): [string, number][] {
  return cells.map((c) => [c.chars, c.width]);
}

/** The cells of the single row that contains `marker`, after the marker itself. */
function cellsAfter(term: XTerm, marker: string): TerminalCell[] {
  const rows = readTerminalCells(term, marker);
  expect(rows).toHaveLength(1);
  return rows[0].cells.slice(marker.length);
}

describe("readTerminalCells against the real xterm with Unicode 11 (#3059)", () => {
  let term: XTerm;
  let host: HTMLDivElement;

  beforeEach(() => {
    term = new XTerm({ cols: 40, rows: 6, scrollback: 100, allowProposedApi: true });
    host = document.createElement("div");
    document.body.appendChild(host);
    term.open(host);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
  });

  afterEach(() => {
    term.dispose();
    host.remove();
  });

  it("stores each CJK character as one wide cell followed by a spacer", async () => {
    await write(term, "CJK:日本語한국\r\n");
    expect(layout(cellsAfter(term, "CJK:"))).toEqual([
      ["日", 2],
      ["", 0],
      ["本", 2],
      ["", 0],
      ["語", 2],
      ["", 0],
      ["한", 2],
      ["", 0],
      ["국", 2],
      ["", 0],
    ]);
  });

  it("attaches combining marks to their base cell instead of a cell of their own", async () => {
    // e + U+0301 (acute), a + U+0308 + U+0304 (two stacked marks), then a plain x.
    await write(term, "MRK:éǟx\r\n");
    expect(layout(cellsAfter(term, "MRK:"))).toEqual([
      ["é", 1],
      ["ǟ", 1],
      ["x", 1],
    ]);
  });

  it("stores RTL text in logical order, one narrow cell per letter", async () => {
    // xterm has no bidi reordering: cells hold the logical order.
    await write(term, "RTL:שלום سلام\r\n");
    expect(
      cellsAfter(term, "RTL:")
        .map((c) => c.chars)
        .join("")
    ).toBe("שלום سلام");
    expect(cellsAfter(term, "RTL:").every((c) => c.width === 1)).toBe(true);
  });

  it("keeps every ZWJ on its emoji and every emoji wide in a ZWJ sequence", async () => {
    // Unicode 11 widths have no grapheme clustering: the family is three wide
    // emoji, each joiner attached to the emoji before it, no codepoint lost.
    const family = `👨${ZWJ}👩${ZWJ}👧`;
    await write(term, `ZWJ:${family}|\r\n`);
    const cells = cellsAfter(term, "ZWJ:");
    expect(layout(cells)).toEqual([
      [`👨${ZWJ}`, 2],
      ["", 0],
      [`👩${ZWJ}`, 2],
      ["", 0],
      ["👧", 2],
      ["", 0],
      ["|", 1],
    ]);
    expect(cells.map((c) => c.chars).join("")).toBe(`${family}|`);
  });

  it("returns every matching row with its absolute buffer index", async () => {
    await write(term, "first\r\nneedle one\r\nmiddle\r\nneedle two\r\n");
    const rows = readTerminalCells(term, "needle");
    expect(rows.map((r) => [r.y, r.text])).toEqual([
      [1, "needle one"],
      [3, "needle two"],
    ]);
  });

  it("reads the visible viewport rows when no filter is given, trimming blank cells", async () => {
    await write(term, "ab\r\n");
    const rows = readTerminalCells(term);
    expect(rows).toHaveLength(term.rows);
    expect(rows[0]).toEqual({
      y: 0,
      text: "ab",
      cells: [
        { x: 0, chars: "a", width: 1 },
        { x: 1, chars: "b", width: 1 },
      ],
    });
    expect(rows[1].cells).toEqual([]);
  });

  it("keeps a trailing wide character's spacer cell", async () => {
    await write(term, "W:語\r\n");
    expect(layout(readTerminalCells(term, "W:")[0].cells)).toEqual([
      ["W", 1],
      [":", 1],
      ["語", 2],
      ["", 0],
    ]);
  });
});
