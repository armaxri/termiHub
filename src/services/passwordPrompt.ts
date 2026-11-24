/**
 * Whether a terminal is waiting for a password, judged from the text in front of
 * its cursor (#5818, slice 8). The frontend cannot see the far side's echo flag
 * (only a local PTY has one to ask), so this reads what the user reads.
 * The recorder uses it to flag what is typed there; see `inputRecorder`, which
 * drops the flag again when the keys turn out to be echoed.
 */

/** Words a password prompt uses, English first. */
const SECRET_WORD =
  "pass(?:word|phrase|code|wd)|pin|otp|one-time code|verification code|passwort|kennwort|" +
  "mot de passe|contrase(?:ñ|n)a|senha|wachtwoord";

/** …with no other sentence after them, ending in the prompt's colon. */
const PROMPT = new RegExp(
  `(?:^|[^\\p{L}\\p{N}])(?:${SECRET_WORD})(?![\\p{L}])[^:：]*[:：]\\s*$`,
  "iu"
);

/** Whether `beforeCursor`, the text on the cursor's line up to it, is such a prompt. */
export function isPasswordPrompt(beforeCursor: string): boolean {
  return PROMPT.test(beforeCursor);
}

/** The parts of an xterm buffer {@link textBeforeCursor} reads. */
export interface CursorBuffer {
  baseY: number;
  cursorX: number;
  cursorY: number;
  getLine(y: number):
    | {
        isWrapped: boolean;
        translateToString(trim?: boolean, start?: number, end?: number): string;
      }
    | undefined;
}

/** The text in front of the cursor, across the rows a long line wraps over. */
export function textBeforeCursor(buffer: CursorBuffer): string {
  let y = buffer.baseY + buffer.cursorY;
  let line = buffer.getLine(y);
  let text = line?.translateToString(false, 0, buffer.cursorX) ?? "";
  while (line?.isWrapped && y > 0) {
    y -= 1;
    line = buffer.getLine(y);
    text = (line?.translateToString(false) ?? "") + text;
  }
  return text;
}
