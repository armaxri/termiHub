import { getPlatform, type Platform } from "@/utils/platform";

/**
 * The key chord that releases a focused remote-desktop canvas back to termiHub
 * (#4328). The canvas forwards every other key to the remote machine, so this
 * chord is the only keyboard way out and must be disclosed wherever the canvas
 * holds focus.
 */
export function isReleaseChord(e: Pick<KeyboardEvent, "ctrlKey" | "altKey" | "shiftKey">): boolean {
  return e.ctrlKey && e.altKey && e.shiftKey;
}

/** The release chord as the user reads it on their keyboard. */
export function releaseChordLabel(platform: Platform = getPlatform()): string {
  return platform === "macos" ? "Ctrl+Option+Shift" : "Ctrl+Alt+Shift";
}
