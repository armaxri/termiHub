### Changed

- File browser: the header keeps only the most-used actions as icons (Up,
  Refresh, New file, New folder, Upload for remote folders, and Paste while
  something is copied). Every other action now sits in a "…" menu with labelled
  entries, including Bookmarks as a sub-menu. On a narrow sidebar more icons
  move into the menu instead of wrapping onto extra rows (#5520).

### Fixed

- File browser: a path longer than the path bar no longer scrolls sideways and
  clips. The current folder stays visible and the middle folders fold into "…",
  which opens a menu of them. The full path is still the tooltip and the value
  of the edit field (#5521).
