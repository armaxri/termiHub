import { useProjectedSettings } from "@/store/useProjectedSettings";
import { eventHoldsModifiers, getReleaseChord, getReleaseChordLabel } from "@/services/keybindings";

/**
 * The key chord that releases a focused remote-desktop canvas back to termiHub
 * (#4328). The canvas forwards every other key to the remote machine, so this
 * chord is the only keyboard way out and must be disclosed wherever the canvas
 * holds focus.
 *
 * The chord is the `release-remote-desktop-keyboard` keybinding (#4524):
 * rebindable in Settings → Keyboard Shortcuts as a modifier-only combo of at
 * least two modifiers, and always falling back to the default Ctrl+Alt+Shift
 * when no usable override exists.
 */
export function isReleaseChord(
  e: Pick<KeyboardEvent, "ctrlKey" | "altKey" | "shiftKey" | "metaKey">
): boolean {
  return eventHoldsModifiers(e, getReleaseChord());
}

/** The release chord as the user reads it, e.g. `Ctrl+Shift+Alt`. */
export function releaseChordLabel(mac?: boolean): string {
  return getReleaseChordLabel(mac);
}

/**
 * The release chord label, re-rendering when the keybinding overrides change
 * (a rebind in Settings persists them into the projected settings).
 */
export function useReleaseChordLabel(): string {
  // Subscribing to the settings region re-renders the caller when a rebind is
  // persisted; the label itself comes from the keybinding service.
  useProjectedSettings();
  return releaseChordLabel();
}
