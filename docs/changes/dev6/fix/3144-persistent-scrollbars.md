### Fixed

- Scrollbars are now persistently visible on all platforms. The global scrollbar
  thumb used to be transparent at rest and only appeared while a scrollable area
  was hovered or focused, which on Windows read as "no scrollbar" and made
  scrolling very hard. The thumb is now shown at rest everywhere (still
  brightening on direct hover) and its resting shade was bumped so it stays
  clearly visible-but-subtle on both dark and light themes (#3144).
