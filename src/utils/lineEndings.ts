import type { LineEnding } from "@/types/terminal";

/**
 * Default line ending used when neither the connection nor the global
 * settings specify one. LF matches typical Unix terminals and fixes the
 * Windows-paste double-line bug out of the box.
 */
export const DEFAULT_LINE_ENDING: LineEnding = "lf";

const SEQUENCES: Record<LineEnding, string> = {
  cr: "\r",
  lf: "\n",
  crlf: "\r\n",
};

/** Matches any single line break: CRLF first (so it is not split into two), then a lone CR or LF. */
const LINE_BREAK_RE = /\r\n|\r|\n/g;

/** Return the raw byte sequence sent for the given line ending mode. */
export function lineEndingSequence(ending: LineEnding): string {
  return SEQUENCES[ending];
}

/**
 * Normalize every line break in `text` to the chosen `ending`.
 *
 * Each CRLF, lone CR, or lone LF becomes exactly one target ending — this is
 * what prevents Windows `\r\n` from being interpreted as two line breaks
 * (the blank-line-between-rows paste bug) on Unix shells and serial devices.
 *
 * Used for both pasted text and the Enter keystroke (which xterm emits as a
 * bare `\r`).
 */
export function normalizeLineEndings(text: string, ending: LineEnding): string {
  return text.replace(LINE_BREAK_RE, SEQUENCES[ending]);
}

/**
 * Resolve the effective line ending for a terminal: a per-connection override
 * wins, then the global default, then the built-in {@link DEFAULT_LINE_ENDING}.
 */
export function resolveLineEnding(
  perConnection: LineEnding | undefined,
  globalDefault: LineEnding | undefined
): LineEnding {
  return perConnection ?? globalDefault ?? DEFAULT_LINE_ENDING;
}
