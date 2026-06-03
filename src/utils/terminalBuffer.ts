import type { IBuffer, IBufferLine } from "@xterm/xterm";

/**
 * Reconstruct logical lines from a terminal buffer, joining the physical rows
 * that the terminal split at its width back into single lines.
 *
 * A row is treated as a continuation of the previous logical line when either:
 *  - xterm flags it as a soft wrap (`isWrapped`), which the terminal sets when
 *    it wraps a long line on its own, or
 *  - `joinFullWidthRows` is enabled and the previous physical row completely
 *    filled the terminal width while the current row is non-empty. This second
 *    rule also rejoins "hard" wraps, where a program emitted its own newline
 *    exactly at the terminal width.
 *
 * Trade-off of the full-width rule: a real line that happens to be exactly
 * `cols` columns wide and is followed by more text gets merged into that text.
 * Empty rows are never merged, so deliberate blank lines are preserved.
 *
 * @param buffer The active xterm buffer to read.
 * @param cols The terminal width in columns.
 * @param joinFullWidthRows Whether to also rejoin hard wraps at the terminal width.
 * @returns The reconstructed text, newline-terminated, with trailing blank lines removed.
 */
export function bufferToLogicalLines(
  buffer: IBuffer,
  cols: number,
  joinFullWidthRows = false
): string {
  const lines: string[] = [];
  let prevRowFilledWidth = false;

  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i);
    const text = line ? line.translateToString(true) : "";
    const isContinuation =
      lines.length > 0 &&
      (!!line?.isWrapped || (joinFullWidthRows && prevRowFilledWidth && text.length > 0));

    if (isContinuation) {
      lines[lines.length - 1] += text;
    } else {
      lines.push(text);
    }

    prevRowFilledWidth = joinFullWidthRows && !!line && cols > 0 && lastColumnWritten(line, cols);
  }

  // Trim trailing empty lines so saved output doesn't end with blank padding.
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines.pop();
  }

  return lines.join("\n") + "\n";
}

/**
 * Whether the last column of a row holds a written glyph, i.e. the row fills the
 * full terminal width. Returns false when the cell API is unavailable (e.g. in
 * mocked buffers), falling back to soft-wrap-only behavior.
 */
function lastColumnWritten(line: IBufferLine, cols: number): boolean {
  if (typeof line.getCell !== "function") return false;
  const cell = line.getCell(cols - 1);
  return !!cell && cell.getChars() !== "";
}
