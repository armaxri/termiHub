### Changed

- File browser: directories with thousands of entries now scroll smoothly and no
  longer freeze the UI. The entry list is virtualized (only the visible rows are
  mounted) instead of rendering every row eagerly. Multi-select, shift-range
  selection, keyboard navigation (arrows/Home/End/type-ahead, which now scrolls
  the focused row into view), drag-and-drop upload, inline rename, and the
  transfer footer all behave exactly as before (#1514).
