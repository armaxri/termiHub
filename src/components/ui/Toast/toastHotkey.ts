import { isMac } from "@/utils/platform";

/**
 * The chord that moves focus into the toast list (sonner's `hotkey`, #5316).
 *
 * sonner defaults to Alt+T and listens on `document` without `preventDefault`,
 * so in a terminal readline's transpose-words (Alt+T) also yanked focus out of
 * xterm whenever a toast was visible. The replacement chords are bound by no
 * app default and are not keys terminal programs use:
 *
 * - macOS: Cmd+Option+T (Cmd never reaches the shell keymap)
 * - Windows/Linux: Ctrl+Shift+F8 (a modifier variant, so a focused terminal's
 *   program keeps the bare function key)
 *
 * The array uses sonner's format: every entry must match, either as a
 * `KeyboardEvent` modifier property (`metaKey`) or as an `event.code` (`KeyT`).
 * It must never be empty: sonner checks `hotkey.every(…)`, which is true for
 * an empty list, so `[]` would steal focus on every key press.
 */
export function toastHotkey(mac: boolean = isMac()): string[] {
  return mac ? ["metaKey", "altKey", "KeyT"] : ["ctrlKey", "shiftKey", "F8"];
}
