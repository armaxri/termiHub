/**
 * Compute the selection end offset for pre-selecting a file's base name when an
 * inline rename begins, so the user can retype the name without clobbering the
 * extension (matching the behaviour of VS Code / Finder / Explorer).
 *
 * The selection always starts at 0. The end is the index of the final `.` for a
 * normal `name.ext`, so only the base name is highlighted. Files with no
 * extension, dotfiles (a single leading dot, e.g. `.bashrc`), and names ending
 * in a dot select the whole string.
 *
 * @returns the caret offset marking the end of the pre-selected base name.
 */
export function baseNameSelectionEnd(name: string): number {
  const lastDot = name.lastIndexOf(".");
  // `lastDot <= 0` covers "no dot" (-1) and a leading-dot dotfile (0).
  // `lastDot === name.length - 1` covers a trailing dot with no extension.
  if (lastDot <= 0 || lastDot === name.length - 1) return name.length;
  return lastDot;
}
