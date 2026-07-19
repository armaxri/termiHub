/**
 * Formatting helpers for presenting recorded macro steps in the manager UI.
 *
 * A {@link MacroStep} holds raw terminal input — the exact bytes a user typed,
 * including control characters (Enter is `\r`, ESC starts escape sequences).
 * Rendering that verbatim would be invisible or corrupt the layout, so the
 * manager shows a human-readable, single-line preview using caret notation
 * (`^M` for carriage return, `^[` for ESC, …) with a few friendly labels.
 */
import type { MacroStep } from "@/types/macro";

/** Friendly labels for the most common control characters typed in a terminal. */
const NAMED_CONTROLS: Record<string, string> = {
  "\r": "⏎",
  "\n": "⏎",
  "\t": "⇥",
  "\x1b": "⎋",
  "\x7f": "⌫",
};

/**
 * Render a single control/non-printable character as a readable token. Named
 * controls (Enter, Tab, ESC, Backspace) use a glyph; every other control byte
 * uses caret notation (`^A` … `^_`), and anything else falls back to a hex
 * escape so the preview is always printable and unambiguous.
 */
function formatControlChar(ch: string): string {
  const named = NAMED_CONTROLS[ch];
  if (named) return named;
  const code = ch.codePointAt(0) ?? 0;
  if (code < 0x20) {
    // Caret notation: control char + 0x40 (e.g. 0x03 → "^C").
    return `^${String.fromCharCode(code + 0x40)}`;
  }
  if (code === 0x7f) return "^?";
  return `\\x${code.toString(16).padStart(2, "0")}`;
}

/**
 * Produce a readable, single-line preview of a step's recorded input. Printable
 * characters pass through; control and non-printable characters are replaced
 * with a caret/glyph token. The result is truncated with an ellipsis when it
 * exceeds {@link maxLength} so long steps never blow out the row width.
 *
 * @param data      The step's raw recorded input.
 * @param maxLength Maximum preview length before truncation (default 80).
 */
export function formatMacroStepData(data: string, maxLength = 80): string {
  let out = "";
  for (const ch of data) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? formatControlChar(ch) : ch;
  }
  if (out.length > maxLength) {
    return `${out.slice(0, maxLength - 1)}…`;
  }
  return out;
}

/**
 * Summarise a macro's whole step list into a compact one-line preview, joining
 * the per-step previews. Used for the collapsed list row where only a hint of
 * the macro's content is shown.
 */
export function summariseMacroSteps(steps: MacroStep[], maxLength = 80): string {
  return formatMacroStepData(steps.map((s) => s.data).join(""), maxLength);
}
