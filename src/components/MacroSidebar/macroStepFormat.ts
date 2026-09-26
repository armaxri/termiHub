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

/*
 * ── Editable escape notation (PROD-039) ─────────────────────────────────────
 *
 * The editor lets a user type or correct a step's input by hand. Raw control
 * characters cannot be typed into (or safely shown in) a text field, so a step
 * is edited in a small, lossless backslash notation:
 *
 *   \r  Enter (carriage return)   \n  line feed      \t  Tab
 *   \e  Escape (ESC, 0x1b)        \\  a literal backslash
 *   \xHH  any byte/code unit 0x00–0xFF given as two hex digits
 *
 * `escapeMacroStepData` renders recorded data into that notation and
 * `parseMacroStepText` turns the notation back into the raw input played into
 * the terminal. They are exact inverses: `parse(escape(d)) === d` for every
 * string `d`, so an untouched recorded step is saved back byte-identical.
 */

/** Named escapes emitted/accepted by the editable notation. */
const ESCAPE_OUT: Record<string, string> = {
  "\\": "\\\\",
  "\r": "\\r",
  "\n": "\\n",
  "\t": "\\t",
  "\x1b": "\\e",
};

const ESCAPE_IN: Record<string, string> = {
  "\\": "\\",
  r: "\r",
  n: "\n",
  t: "\t",
  e: "\x1b",
};

/**
 * Render a step's raw input as editable text: printable characters pass
 * through, a backslash is doubled, Enter/LF/Tab/ESC use their short escapes and
 * every other control character (0x00–0x1f, 0x7f) becomes `\xHH`. The result
 * contains no control characters, so it is safe to put in an input field.
 */
export function escapeMacroStepData(data: string): string {
  let out = "";
  for (const ch of data) {
    const named = ESCAPE_OUT[ch];
    if (named) {
      out += named;
      continue;
    }
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? `\\x${code.toString(16).padStart(2, "0")}` : ch;
  }
  return out;
}

/** Result of {@link parseMacroStepText}. */
export type MacroStepParseResult = { ok: true; data: string } | { ok: false; error: string };

/**
 * Parse editable step text (see {@link escapeMacroStepData}) back into the raw
 * input a step plays into the terminal. Rejects an unknown escape (`\q`), a
 * malformed hex escape (`\x4`, `\xZZ`) and a dangling trailing backslash with a
 * message naming the offending sequence, so the editor can block Save.
 */
export function parseMacroStepText(text: string): MacroStepParseResult {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = text[i + 1];
    if (next === undefined) {
      return { ok: false, error: "Trailing backslash — use \\\\ for a literal backslash." };
    }
    if (next === "x") {
      const hex = text.slice(i + 2, i + 4);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
        return { ok: false, error: `Invalid hex escape "\\x${hex}" — use two hex digits.` };
      }
      out += String.fromCharCode(parseInt(hex, 16));
      i += 3;
      continue;
    }
    const mapped = ESCAPE_IN[next];
    if (mapped === undefined) {
      return {
        ok: false,
        error: `Unknown escape "\\${next}" — use \\r, \\n, \\t, \\e, \\xHH or \\\\.`,
      };
    }
    out += mapped;
    i += 1;
  }
  return { ok: true, data: out };
}
