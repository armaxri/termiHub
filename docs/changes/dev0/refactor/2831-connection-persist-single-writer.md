### Fixed

- Connection tree: when saving a connection or folder change to disk fails (a
  delete, add, edit, move, reorder, folder toggle, or a move to another file),
  the sidebar now shows exactly what is on disk again, in its original
  position. Previously a connection whose delete failed reappeared at the end
  of its list until the next reload (#2831).

### Internal

- The connection save commands are now the only writer of the shared
  connection tree state. Each save writes disk and updates the tree state in
  one serialised step, success or failure, and the sidebar shows pending
  changes in a local preview until the save completes. The old
  `connection.*` tree intents and the client-side undo shim were removed
  (#2831).
