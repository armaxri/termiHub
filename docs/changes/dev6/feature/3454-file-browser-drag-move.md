### Added

- File browser drag-to-move: drag a row (or a multi-selection) onto a folder
  row or a path breadcrumb to move it there. On the same filesystem this is a
  rename, so no data is copied. Hold **Alt/Option** while releasing to copy
  instead. The folder under the pointer is highlighted, or marked as refused
  when the drop is not allowed: a folder into itself or one of its subfolders,
  or into a folder reported read-only. If an item with the same name already
  exists in the destination, you are asked before it is replaced.
- **Move to…** / **Copy to…** in the file and multi-selection context menus
  run the same move/copy from the keyboard, with the destination folder typed
  in a dialog (#3454, audit PROD-006).
