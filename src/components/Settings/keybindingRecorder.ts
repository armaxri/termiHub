import type { KeyCombo } from "@/types/keybindings";
import { formatBindingForDisplay, getActionScope } from "@/services/keybindings";
import { MODIFIER_KEYS } from "./modifierOnlyRecorder";

/**
 * Turning a keydown into a recorded shortcut in Settings ▸ Keyboard shortcuts
 * (#5842), and the rules a recorded shortcut must follow.
 */

/** What one keydown means while a shortcut is being recorded. */
export type RecordedKey =
  /** A usable key combination. */
  | { kind: "combo"; combo: KeyCombo }
  /** Not a key of its own (a lone modifier, an IME composition step): keep waiting. */
  | { kind: "ignore" }
  /**
   * A dead key (it starts an accent, e.g. ´ ` ^ on a German layout) on a key
   * whose physical position is not a letter or digit. It produces no key of
   * its own, so a shortcut on it could never match.
   */
  | { kind: "dead-key" };

/** The keydown fields the recorder reads. */
export type RecorderKeyEvent = Pick<
  KeyboardEvent,
  "key" | "code" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey"
> & { isComposing?: boolean };

/** `KeyboardEvent.key` values that are never a shortcut key of their own. */
const NON_KEYS = new Set([...MODIFIER_KEYS, "AltGraph", "Process", "Unidentified", "CapsLock"]);

/** The letter or digit of a physical `KeyX` / `DigitN` code, else `null`. */
function physicalKey(code: string | undefined): string | null {
  const letter = /^Key([A-Z])$/.exec(code ?? "");
  if (letter) return letter[1].toLowerCase();
  const digit = /^Digit([0-9])$/.exec(code ?? "");
  return digit ? digit[1] : null;
}

/** Whether `key` is a single printable ASCII character. */
function isAsciiChar(key: string): boolean {
  return key.length === 1 && key.charCodeAt(0) < 128;
}

/**
 * The recorded meaning of a keydown.
 *
 * Layouts with dead keys and Option/AltGr characters (a German Mac: Option+L
 * types "@", Option+N starts "~") report the produced character, not the key.
 * For a letter or digit key the recorder stores the physical key instead —
 * the shortcut engine matches letters and digits by `event.code`, so Option+L
 * is recorded as Alt+L and fires on that key again. A dead key elsewhere on
 * the keyboard has no usable key and is refused.
 */
export function recordedKeyFromEvent(e: RecorderKeyEvent): RecordedKey {
  if (e.isComposing || NON_KEYS.has(e.key)) return { kind: "ignore" };

  const physical = physicalKey(e.code);
  let key = e.key;
  if (e.key === "Dead") {
    if (!physical) return { kind: "dead-key" };
    key = physical;
  } else if (physical && (e.altKey || !isAsciiChar(e.key))) {
    key = physical;
  }
  if (physical && key === physical && e.shiftKey) key = key.toUpperCase();

  return {
    kind: "combo",
    combo: {
      key,
      ctrl: e.ctrlKey || undefined,
      shift: e.shiftKey || undefined,
      alt: e.altKey || undefined,
      meta: e.metaKey || undefined,
    },
  };
}

/** Whether `combo` is a function key (F1–F24) without Ctrl, Alt or Cmd. Shift does not count. */
export function isPlainFunctionKey(combo: KeyCombo): boolean {
  return /^F([1-9]|1[0-9]|2[0-4])$/.test(combo.key) && !combo.ctrl && !combo.alt && !combo.meta;
}

/**
 * Whether binding `action` to `binding` would take a key from terminal programs.
 *
 * Maintainer rule (#4773): a focused terminal keeps the keys its programs use —
 * plain function keys above all (Midnight Commander, htop, nano). An action
 * that fires while a terminal has focus therefore needs Ctrl, Alt or Cmd on a
 * function key. Actions that already yield to a focused terminal, or never
 * fire in one (remote desktop, file browser), may use the plain key.
 */
export function takesKeyFromTerminalPrograms(
  action: string,
  binding: KeyCombo | KeyCombo[]
): boolean {
  const scope = getActionScope(action);
  if (scope === "yields-to-terminal" || scope === "remote-desktop" || scope === "file-browser") {
    return false;
  }
  const first = Array.isArray(binding) ? binding[0] : binding;
  return first !== undefined && isPlainFunctionKey(first);
}

/** Why a plain function key was refused for `label`, and what to press instead. */
export function terminalKeyRejectionText(label: string, binding: KeyCombo | KeyCombo[]): string {
  const first = Array.isArray(binding) ? binding[0] : binding;
  return (
    `${formatBindingForDisplay(first)} on its own stays with terminal programs such as ` +
    `Midnight Commander or htop. Add Ctrl, Alt or Cmd so "${label}" also works in a terminal. ` +
    `${label} shortcut unchanged.`
  );
}

/** Why a dead key was refused for `label`. */
export function deadKeyRejectionText(label: string): string {
  return (
    "That key starts an accent on your keyboard layout, so it cannot be a shortcut. " +
    `Pick another key. ${label} shortcut unchanged.`
  );
}
