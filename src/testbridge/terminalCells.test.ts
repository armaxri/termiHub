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
import { paletteColor, readTerminalCells } from "./terminalCells";
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
        { x: 0, chars: "a", width: 1, fg: "#ffffff", bg: "#000000", bold: false },
        { x: 1, chars: "b", width: 1, fg: "#ffffff", bg: "#000000", bold: false },
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

describe("readTerminalCells colours and bold (#4937)", () => {
  const theme = {
    background: "#0f1117",
    foreground: "#dde1ec",
    black: "#0f1117",
    red: "#cd3131",
    brightBlue: "#3b8eea",
  };
  let term: XTerm;
  let host: HTMLDivElement;

  beforeEach(() => {
    term = new XTerm({ cols: 40, rows: 6, theme, allowProposedApi: true });
    host = document.createElement("div");
    document.body.appendChild(host);
    term.open(host);
  });

  afterEach(() => {
    term.dispose();
    host.remove();
  });

  /** `[chars, fg, bg, bold]` of the cells after `marker`. */
  async function colours(
    data: string,
    marker: string
  ): Promise<[string, string, string, boolean][]> {
    await write(term, `${data}\x1b[0m\r\n`);
    return cellsAfter(term, marker).map((c) => [c.chars, c.fg, c.bg, c.bold]);
  }

  it("resolves default colours to the theme foreground and background", async () => {
    expect(await colours("D:x", "D:")).toEqual([["x", "#dde1ec", "#0f1117", false]]);
  });

  it("resolves ANSI colours through the theme palette", async () => {
    expect(await colours("A:\x1b[31mr\x1b[94mb\x1b[40m ", "A:")).toEqual([
      ["r", "#cd3131", "#0f1117", false],
      ["b", "#3b8eea", "#0f1117", false],
      [" ", "#3b8eea", "#0f1117", false],
    ]);
  });

  it("falls back to xterm's default for an ANSI colour the theme leaves unset", async () => {
    expect(await colours("U:\x1b[32mg", "U:")).toEqual([["g", "#4e9a06", "#0f1117", false]]);
  });

  it("resolves 256-colour cube, grey ramp and truecolour backgrounds", async () => {
    const cells = await colours(
      "C:\x1b[48;5;196m \x1b[48;5;46m \x1b[48;5;21m \x1b[48;5;244m \x1b[48;2;1;2;3m ",
      "C:"
    );
    expect(cells.map((c) => c[2])).toEqual(["#ff0000", "#00ff00", "#0000ff", "#808080", "#010203"]);
  });

  it("swaps the colours of an inverse cell and reports bold", async () => {
    expect(await colours("I:\x1b[7;31mi\x1b[27;1mB", "I:")).toEqual([
      ["i", "#0f1117", "#cd3131", false],
      ["B", "#cd3131", "#0f1117", true],
    ]);
  });

  it("builds the same 256-colour table as xterm", () => {
    expect(paletteColor(theme, 1)).toBe("#cd3131");
    expect(paletteColor(theme, 16)).toBe("#000000");
    expect(paletteColor(theme, 226)).toBe("#ffff00");
    expect(paletteColor(theme, 201)).toBe("#ff00ff");
    expect(paletteColor(theme, 232)).toBe("#080808");
    expect(paletteColor(theme, 255)).toBe("#eeeeee");
    expect(paletteColor({ extendedAnsi: ["#123456"] }, 16)).toBe("#123456");
  });
});
