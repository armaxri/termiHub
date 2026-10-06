/**
 * "Combine emoji (experimental)" (#4177) against the REAL `@xterm/xterm`: the
 * buffer cell layout of emoji grapheme clusters with the setting off (the app's
 * Unicode 11 widths — one wide cell group per component emoji) and on
 * (`@xterm/addon-unicode-graphemes` — each cluster one double-width glyph).
 * Cells are read with the test-bridge reader (`readTerminalCells`, #3059), the
 * same model `tests/system/tests/test_terminal_glyph_shaping.py` asserts live.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Terminal as XTerm } from "@xterm/xterm";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { readTerminalCells } from "@/testbridge/terminalCells";
import type { TerminalCell } from "@/testbridge/protocol";
import {
  applyCombineEmoji,
  UNICODE_VERSION_DEFAULT,
  UNICODE_VERSION_GRAPHEMES,
} from "./unicodeWidth";

const ZWJ = "‍";
const FAMILY = `👨${ZWJ}👩${ZWJ}👧`;
const THUMBS_UP_MEDIUM = "👍🏽"; // U+1F44D + U+1F3FD (skin-tone modifier)
const FLAG_DE = "🇩🇪"; // regional indicators D + E

function write(term: XTerm, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, () => resolve()));
}

function layout(cells: TerminalCell[]): [string, number][] {
  return cells.map((c) => [c.chars, c.width]);
}

function cellsAfter(term: XTerm, marker: string): TerminalCell[] {
  const rows = readTerminalCells(term, marker);
  expect(rows).toHaveLength(1);
  return rows[0].cells.slice(marker.length);
}

describe("Combine emoji setting against the real xterm (#4177)", () => {
  let term: XTerm;
  let host: HTMLDivElement;

  beforeEach(() => {
    term = new XTerm({ cols: 40, rows: 8, scrollback: 100, allowProposedApi: true });
    host = document.createElement("div");
    document.body.appendChild(host);
    term.open(host);
    // As Terminal.tsx wires it: Unicode 11 always loaded, then the setting.
    term.loadAddon(new Unicode11Addon());
  });

  afterEach(() => {
    term.dispose();
    host.remove();
  });

  describe("setting off (default Unicode 11 layout)", () => {
    beforeEach(() => applyCombineEmoji(term, false));

    it("selects the Unicode 11 width tables", () => {
      expect(term.unicode.activeVersion).toBe(UNICODE_VERSION_DEFAULT);
    });

    it("lays out a ZWJ family as three wide emoji", async () => {
      await write(term, `ZWJ:${FAMILY}|\r\n`);
      expect(layout(cellsAfter(term, "ZWJ:"))).toEqual([
        [`👨${ZWJ}`, 2],
        ["", 0],
        [`👩${ZWJ}`, 2],
        ["", 0],
        ["👧", 2],
        ["", 0],
        ["|", 1],
      ]);
    });

    it("gives a skin-tone modifier its own wide cell", async () => {
      await write(term, `SKN:${THUMBS_UP_MEDIUM}|\r\n`);
      expect(layout(cellsAfter(term, "SKN:"))).toEqual([
        ["👍", 2],
        ["", 0],
        ["🏽", 2],
        ["", 0],
        ["|", 1],
      ]);
    });

    it("lays out a flag as two narrow regional indicators", async () => {
      await write(term, `FLG:${FLAG_DE}|\r\n`);
      expect(layout(cellsAfter(term, "FLG:"))).toEqual([
        ["🇩", 1],
        ["🇪", 1],
        ["|", 1],
      ]);
    });
  });

  describe("setting on (grapheme clustering)", () => {
    beforeEach(() => applyCombineEmoji(term, true));

    it("selects the grapheme width tables", () => {
      expect(term.unicode.activeVersion).toBe(UNICODE_VERSION_GRAPHEMES);
    });

    it("lays out a ZWJ family as one double-width glyph", async () => {
      await write(term, `ZWJ:${FAMILY}|\r\n`);
      expect(layout(cellsAfter(term, "ZWJ:"))).toEqual([
        [FAMILY, 2],
        ["", 0],
        ["|", 1],
      ]);
    });

    it("keeps a skin-tone modifier on its emoji in one double-width glyph", async () => {
      await write(term, `SKN:${THUMBS_UP_MEDIUM}|\r\n`);
      expect(layout(cellsAfter(term, "SKN:"))).toEqual([
        [THUMBS_UP_MEDIUM, 2],
        ["", 0],
        ["|", 1],
      ]);
    });

    it("lays out a flag as one double-width glyph", async () => {
      await write(term, `FLG:${FLAG_DE}|\r\n`);
      expect(layout(cellsAfter(term, "FLG:"))).toEqual([
        [FLAG_DE, 2],
        ["", 0],
        ["|", 1],
      ]);
    });
  });

  it("switches live: new output follows the setting, existing lines keep their layout", async () => {
    applyCombineEmoji(term, false);
    await write(term, `OLD:${FAMILY}\r\n`);
    applyCombineEmoji(term, true);
    await write(term, `NEW:${FAMILY}\r\n`);
    expect(cellsAfter(term, "OLD:")).toHaveLength(6);
    expect(layout(cellsAfter(term, "NEW:"))).toEqual([
      [FAMILY, 2],
      ["", 0],
    ]);

    // And back off again — the addon stays loaded, only the version flips.
    applyCombineEmoji(term, false);
    expect(term.unicode.activeVersion).toBe(UNICODE_VERSION_DEFAULT);
    await write(term, `OFF:${FAMILY}\r\n`);
    expect(cellsAfter(term, "OFF:")).toHaveLength(6);
  });
});
