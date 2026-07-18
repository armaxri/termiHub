### Added

- The built-in editor's "file changed on disk" notice is now actionable when the
  buffer has unsaved edits. The banner offers **Reload from disk** (discard your
  unsaved edits and load the on-disk version) and **Keep my changes** (dismiss the
  notice and keep your edits; your next save overwrites disk with your version).
  Nothing is destructive without an explicit click — leaving both buttons keeps
  your edits and leaves disk untouched, and if the file changes on disk again the
  notice re-appears. (#1620)
