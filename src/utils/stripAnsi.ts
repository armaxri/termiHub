/**
 * The one ANSI/VT escape stripper for matching terminal output against
 * user-authored patterns (on-output-match triggers, `wait-for-output` steps).
 *
 * The matching itself is delegated to the `strip-ansi` library (`ansi-regex`),
 * which covers CSI/SGR (including the colon form `38:2:r:g:b` and `~`-final
 * sequences such as bracketed paste) and OSC sequences terminated by BEL or ST
 * — window titles (OSC 0/2), cwd (OSC 7), hyperlinks (OSC 8) and the shell
 * integration marks (OSC 133). A hand-rolled CSI-only regex used to live in
 * two places and let every OSC sequence through (#4355).
 */
import stripAnsiLib from "strip-ansi";

/** Remove ANSI escape sequences (CSI and OSC) from terminal text. */
export function stripAnsi(text: string): string {
  return stripAnsiLib(text);
}

/**
 * A trailing escape sequence that has not been terminated yet: a lone ESC, an
 * OSC still waiting for its BEL/ST (possibly with the ESC of `ESC \` already
 * received), or a CSI/charset sequence with parameters but no final byte.
 * Anchored at both ends; it is tested against a suffix starting at an ESC/CSI.
 */
const INCOMPLETE_ESCAPE_RE =
  // eslint-disable-next-line no-control-regex -- matching escape bytes is the intent
  /^(?:\u001b\][^\u0007\u009c\u001b]*\u001b?|[\u001b\u009b][[()#;?]*(?:\d{1,4}(?:[;:]\d{0,4})*)?)$/;

/** Escape introducers: ESC and the 8-bit CSI. */
// eslint-disable-next-line no-control-regex -- matching escape bytes is the intent
const ESCAPE_START_RE = /[\u001b\u009b]/g;

/**
 * Strips ANSI from a stream of output chunks. A PTY may split an escape
 * sequence across two chunks, and stripping each chunk on its own would leave
 * both halves behind; this holds an incomplete trailing sequence back and
 * prepends it to the next chunk, so split sequences are removed too.
 */
export class AnsiStreamStripper {
  /**
   * The longest incomplete sequence held back. A longer unterminated run is
   * not a real escape sequence worth waiting for; it is released as text so a
   * stray ESC can never swallow the stream.
   */
  static readonly MAX_CARRY_CHARS = 4096;

  private carry = "";

  /** Strip `chunk` (after any held-back prefix) and return the visible text. */
  push(chunk: string): string {
    const text = this.carry + chunk;
    const cut = incompleteEscapeStart(text, AnsiStreamStripper.MAX_CARRY_CHARS);
    this.carry = cut === -1 ? "" : text.slice(cut);
    return stripAnsi(cut === -1 ? text : text.slice(0, cut));
  }

  /** Drop any held-back partial sequence. */
  reset(): void {
    this.carry = "";
  }
}

/**
 * Index where an incomplete trailing escape sequence starts in `text`, or -1.
 * Only the last `maxChars` characters are considered.
 */
function incompleteEscapeStart(text: string, maxChars: number): number {
  const from = Math.max(0, text.length - maxChars);
  ESCAPE_START_RE.lastIndex = from;
  for (let m = ESCAPE_START_RE.exec(text); m !== null; m = ESCAPE_START_RE.exec(text)) {
    if (INCOMPLETE_ESCAPE_RE.test(text.slice(m.index))) return m.index;
  }
  return -1;
}
