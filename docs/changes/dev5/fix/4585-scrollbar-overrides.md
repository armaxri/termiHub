### Fixed

- UI: the terminal's scrollbars now follow the app-wide persistent scrollbar style.
  The vertical scrollbar thumb (and the horizontal one in horizontal-scroll mode) is
  visible at rest instead of appearing only while the pointer is over the terminal,
  and brightens on hover or drag (#4585).
- UI: the file browser's breadcrumb row no longer hides its scrollbar, so a long path
  shows the same thin scrollbar as every other scrollable surface (#4585).
