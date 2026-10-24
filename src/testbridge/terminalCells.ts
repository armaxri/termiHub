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
 *
 * Each cell also carries the colours it paints in and its bold flag (#4937),
 * resolved through the live theme the way the renderer resolves them, so a
 * native window capture can be checked against the exact colour each cell
 * should show.
 */
import type { IBufferCell, ITheme, Terminal as XTerm } from "@xterm/xterm";
import type { TerminalCell, TerminalCellRow } from "./protocol";

/** The 16 ANSI theme keys, in palette order. */
const ANSI_KEYS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

/** xterm's own defaults for an ANSI colour the theme leaves unset. */
const XTERM_ANSI_DEFAULTS = [
  "#2e3436",
  "#cc0000",
  "#4e9a06",
  "#c4a000",
  "#3465a4",
  "#75507b",
  "#06989a",
  "#d3d7cf",
  "#555753",
  "#ef2929",
  "#8ae234",
  "#fce94f",
  "#729fcf",
  "#ad7fa8",
  "#34e2e2",
  "#eeeeec",
];

const hex2 = (n: number): string => n.toString(16).padStart(2, "0");

/** `#rrggbb` of a packed `0xRRGGBB` truecolour value. */
function rgbHex(value: number): string {
  return `#${hex2((value >> 16) & 0xff)}${hex2((value >> 8) & 0xff)}${hex2(value & 0xff)}`;
}

/**
 * The colour of 256-palette entry `index`: 0-15 from the theme (xterm's
 * defaults where unset), 16-231 the 6x6x6 cube, 232-255 the grey ramp —
 * the same table xterm builds.
 */
export function paletteColor(theme: ITheme, index: number): string {
  if (index < 16) {
    return theme[ANSI_KEYS[index]] ?? XTERM_ANSI_DEFAULTS[index];
  }
  const extended = theme.extendedAnsi?.[index - 16];
  if (extended) return extended;
  if (index < 232) {
    const steps = [0x00, 0x5f, 0x87, 0xaf, 0xd7, 0xff];
    const i = index - 16;
    return `#${hex2(steps[Math.floor(i / 36) % 6])}${hex2(steps[Math.floor(i / 6) % 6])}${hex2(steps[i % 6])}`;
  }
  const grey = 8 + (index - 232) * 10;
  return `#${hex2(grey)}${hex2(grey)}${hex2(grey)}`;
}

/** The colours a cell paints in, after inverse video, resolved through `theme`. */
function cellColors(cell: IBufferCell, theme: ITheme): { fg: string; bg: string } {
  const resolve = (
    isDefault: boolean,
    isPalette: boolean,
    value: number,
    fallback: string
  ): string => {
    if (isDefault) return fallback;
    return isPalette ? paletteColor(theme, value) : rgbHex(value);
  };
  const fg = resolve(
    cell.isFgDefault(),
    cell.isFgPalette(),
    cell.getFgColor(),
    theme.foreground ?? "#ffffff"
  );
  const bg = resolve(
    cell.isBgDefault(),
    cell.isBgPalette(),
    cell.getBgColor(),
    theme.background ?? "#000000"
  );
  return cell.isInverse() ? { fg: bg, bg: fg } : { fg, bg };
}

/** The cells of buffer line `y`, without the blank cells after the last glyph. */
function readRowCells(xterm: XTerm, y: number): TerminalCell[] {
  const line = xterm.buffer.active.getLine(y);
  if (!line) return [];
  const theme = xterm.options.theme ?? {};
  const cells: TerminalCell[] = [];
  let lastGlyph = -1;
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x);
    if (!cell) break;
    const chars = cell.getChars();
    const width = cell.getWidth();
    cells.push({ x, chars, width, ...cellColors(cell, theme), bold: cell.isBold() !== 0 });
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
