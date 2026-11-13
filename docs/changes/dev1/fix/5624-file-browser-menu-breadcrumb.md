### Added

- File browser: a "Sort by" sub-menu in the "…" menu (Name / Modified / Size, ascending or
  descending), so the list can be sorted at every sidebar width. When the sorted column is
  hidden, the Name header says "sorted by modified" or "sorted by size".
- File browser: "Copy path" in the "…" menu and in the path bar's folded-folders menu.

### Changed

- File browser: Up uses a parent-folder arrow, so it no longer looks like Upload.
- File browser: the path bar has a subtle field background, the root shows a drive icon instead
  of a bare "/", the current folder is in the primary text colour, and the "…" for folded
  folders looks like a button. When there is room, the direct parent folder stays visible,
  shortened in the middle.
- File browser: the menu entries now read "Follow terminal folder" and "Open this folder in
  terminal". The permanent "Drop files here" footer is gone; the drop hint shows only while
  dragging.

### Fixed

- File browser: at the minimum sidebar width the "…" menu no longer opens over the activity
  bar; it stays right of the sidebar's edge and inside the window.
- Menus no longer draw a thick focus outline around the whole popover when opened.
