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

/**
 * Reads the text in front of a terminal's cursor ({@link textBeforeCursor}) as it is
 * once all output that has arrived by now is in the buffer, and none that comes later
 * (#6070). Calls back at once when nothing is on its way, with `null` when there is no
 * terminal to read, and never when output was lost, so that it cannot be told.
 */
export type PromptReader = (then: (beforeCursor: string | null) => void) => void;

/** The line a prompt was seen on. */
export interface PromptPin {
  /** Whether the cursor is still on that line. */
  holds: () => boolean;
  dispose: () => void;
}

/** What a live terminal knows about the prompt it shows. */
export interface TerminalPrompt {
  read: PromptReader;
  /** Grows with everything that arrives, whether it shows yet or not. */
  arrived: () => number;
  /** Remember the cursor's line. */
  pin: () => PromptPin;
}

const terminals = new Map<string, TerminalPrompt>();

/** Register the live terminal of tab `tabId`. Returns the way to take it back. */
export function registerTerminalPrompt(tabId: string, prompt: TerminalPrompt): () => void {
  terminals.set(tabId, prompt);
  return () => {
    if (terminals.get(tabId) === prompt) terminals.delete(tabId);
  };
}

/** The {@link TerminalPrompt} of tab `tabId`, while it shows a live session. */
export function promptOfTerminal(tabId: string): TerminalPrompt | undefined {
  return terminals.get(tabId);
}

/** The {@link PromptReader} of tab `tabId`, as it is now. */
export function readTerminalPrompt(tabId: string, then: Parameters<PromptReader>[0]): void {
  const terminal = terminals.get(tabId);
  if (terminal) terminal.read(then);
  else then(null);
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
