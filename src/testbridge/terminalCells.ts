/**
 * Read xterm's buffer cell model for the `readTerminalCells` bridge verb (#3059).
 *
 * `readTerminal` returns reconstructed text, which cannot tell a CJK character
 * stored as one wide cell from two narrow ones, or a combining mark attached to
 * its base from one sitting in a cell of its own. This reads the cells straight
 * from xterm's public buffer API: each cell's characters (`getChars()`) and its
 * column width (`getWidth()`: 2 for the head of a wide character, 0 for the
 * spacer cell that follows it, 1 otherwise). The Python bridge harness asserts
 * glyph layout on it in a real WebView, and `terminalCells.test.ts` pins the
 * same model per PR against the real xterm with the app's Unicode 11 config.
 */
import type { Terminal as XTerm } from "@xterm/xterm";
import type { TerminalCell, TerminalCellRow } from "./protocol";

/** The cells of buffer line `y`, without the blank cells after the last glyph. */
function readRowCells(xterm: XTerm, y: number): TerminalCell[] {
  const line = xterm.buffer.active.getLine(y);
  if (!line) return [];
  const cells: TerminalCell[] = [];
  let lastGlyph = -1;
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x);
    if (!cell) break;
    const chars = cell.getChars();
    const width = cell.getWidth();
    cells.push({ x, chars, width });
    // A wide character's spacer cell (width 0) belongs to the glyph before it.
    if (chars !== "" || width === 0) lastGlyph = x;
  }
  return cells.slice(0, lastGlyph + 1);
}

/**
 * The cell model of a terminal's buffer rows. With `contains`, every buffer row
 * (scrollback included) whose text contains it; without, the visible viewport.
 * Rows are in buffer order, each with its absolute buffer index `y`.
 */
export function readTerminalCells(xterm: XTerm, contains?: string): TerminalCellRow[] {
  const buffer = xterm.buffer.active;
  const first = contains === undefined ? buffer.viewportY : 0;
  const end = contains === undefined ? buffer.viewportY + xterm.rows : buffer.length;
  const rows: TerminalCellRow[] = [];
  for (let y = first; y < Math.min(end, buffer.length); y++) {
    const text = buffer.getLine(y)?.translateToString(true) ?? "";
    if (contains !== undefined && !text.includes(contains)) continue;
    rows.push({ y, text, cells: readRowCells(xterm, y) });
  }
  return rows;
}
