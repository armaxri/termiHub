import { isMac } from "./platform";

/** Check whether a keyboard event is a platform-appropriate copy shortcut. */
export function isCopyShortcut(e: KeyboardEvent): boolean {
  if (isMac()) {
    // macOS: Cmd+C
    return e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && e.key === "c";
  }
  // Win/Linux: Ctrl+Shift+C
  return e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey && e.key === "C";
}

/** Check whether a keyboard event is a platform-appropriate paste shortcut. */
export function isPasteShortcut(e: KeyboardEvent): boolean {
  if (isMac()) {
    // macOS: Cmd+V
    return e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && e.key === "v";
  }
  // Win/Linux: Ctrl+Shift+V
  return e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey && e.key === "V";
}

/** Check whether a keyboard event is a platform-appropriate select-all shortcut. */
export function isSelectAllShortcut(e: KeyboardEvent): boolean {
  if (isMac()) {
    return e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && e.key === "a";
  }
  return e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey && e.key === "A";
}
