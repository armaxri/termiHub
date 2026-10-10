import type { KeyCombo } from "@/types/keybindings";
import {
  comboModifierCount,
  formatBindingForDisplay,
  isValidModifierOnlyCombo,
  MIN_MODIFIER_ONLY_MODIFIERS,
} from "@/services/keybindings";

/**
 * Recorder for modifier-only key chords in Settings → Keyboard Shortcuts
 * (#4524). Used by the remote-desktop release chord, the only keyboard way out
 * of a focused remote-desktop canvas, so it refuses anything that would leave
 * the user without a usable escape.
 */

/**
 * Spoken instructions while a modifier-only chord (the remote-desktop release
 * chord, #4524) is being recorded: hold the modifiers, then let go.
 */
export const MODIFIER_ONLY_RECORDING_INSTRUCTIONS =
  "Hold at least two modifier keys, such as Ctrl, Alt, Shift or Cmd, then release them. " +
  "Escape cancels, Tab leaves.";

/** Why a modifier-only recording was rejected (see {@link recordModifierOnlyChord}). */
export type ModifierOnlyRejection = "too-few-modifiers" | "non-modifier-key" | "cannot-clear";

export const MODIFIER_ONLY_REJECTION_TEXT: Record<ModifierOnlyRejection, string> = {
  "too-few-modifiers": `Use at least ${MIN_MODIFIER_ONLY_MODIFIERS} modifier keys together.`,
  "non-modifier-key": "Use modifier keys only (Ctrl, Alt, Shift, Cmd).",
  "cannot-clear": "This shortcut cannot be cleared: it is the only keyboard way out.",
};

/** Lone modifier key names as reported by `KeyboardEvent.key`. */
export const MODIFIER_KEYS = ["Control", "Shift", "Alt", "Meta"];

export interface ModifierOnlyRecorderCallbacks {
  /** Live preview of the modifiers held so far, e.g. `Ctrl+Alt`. */
  onPreview: (preview: string) => void;
  onComplete: (combo: KeyCombo) => void;
  onReject: (reason: ModifierOnlyRejection) => void;
  /** `refocus` is false when Tab left recording and the browser moves focus. */
  onCancel: (refocus: boolean) => void;
}

/**
 * Record a modifier-only chord (#4524): the user holds modifiers and the chord
 * is the largest set held at once, committed when the first one is released.
 * Fewer than {@link MIN_MODIFIER_ONLY_MODIFIERS} modifiers, a non-modifier key
 * or Backspace (clear) are rejected so the release chord stays usable. Returns
 * the cleanup that detaches the listeners.
 */
export function recordModifierOnlyChord(cb: ModifierOnlyRecorderCallbacks): () => void {
  let peak: KeyCombo | null = null;

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Tab" && !e.ctrlKey && !e.altKey && !e.metaKey) {
      cb.onCancel(false);
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") {
      cb.onCancel(true);
      return;
    }
    if (e.key === "Backspace") {
      cb.onReject("cannot-clear");
      return;
    }
    if (!MODIFIER_KEYS.includes(e.key)) {
      cb.onReject("non-modifier-key");
      return;
    }
    const held: KeyCombo = {
      key: "",
      ctrl: e.ctrlKey || undefined,
      shift: e.shiftKey || undefined,
      alt: e.altKey || undefined,
      meta: e.metaKey || undefined,
    };
    if (!peak || comboModifierCount(held) >= comboModifierCount(peak)) peak = held;
    cb.onPreview(formatBindingForDisplay(held));
  };

  const handleKeyUp = (e: KeyboardEvent) => {
    if (!peak || !MODIFIER_KEYS.includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    if (isValidModifierOnlyCombo(peak)) cb.onComplete(peak);
    else cb.onReject("too-few-modifiers");
  };

  cb.onPreview("");
  window.addEventListener("keydown", handleKeyDown, true);
  window.addEventListener("keyup", handleKeyUp, true);
  return () => {
    window.removeEventListener("keydown", handleKeyDown, true);
    window.removeEventListener("keyup", handleKeyUp, true);
  };
}
