/**
 * Validation for renaming a folder in the connection or agent tree (#5233).
 *
 * Sibling names are matched exactly (case-sensitively), the same way the
 * desktop store de-duplicates them (`find_unique_name` in
 * `src-tauri/src/connection/tree.rs`). Rejecting a clash up front keeps the
 * store from silently renaming the folder — or a sibling — to `<name> (1)`.
 *
 * @param name The trimmed candidate name.
 * @param siblingNames Names already used next to the folder (the folder itself excluded).
 * @returns A message to show under the input, or `null` when the name is fine.
 */
export function folderRenameError(name: string, siblingNames: Iterable<string>): string | null {
  if (!name.trim()) return "Enter a name.";
  for (const sibling of siblingNames) {
    if (sibling === name) return `“${name}” already exists here. Choose another name.`;
  }
  return null;
}
