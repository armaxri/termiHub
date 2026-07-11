### Fixed

- Connection tree: toggling a folder while a search filter is active no longer
  changes the folder's stored expansion state. Filtering force-expands matching
  folders, so folder toggles (row click and the keyboard
  ArrowLeft/ArrowRight/Enter/Space paths) previously mutated the stored state
  invisibly and left folders unexpectedly collapsed or expanded once the filter
  was cleared. Toggles are now ignored while filtering, so clearing the filter
  returns the tree to exactly the expansion state it had before (#1378).
