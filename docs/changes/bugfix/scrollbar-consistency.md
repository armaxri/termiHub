### Changed

- UI: scrollbars are now consistent across the whole app. Every scrollable surface
  (tabs, sidebars/lists, and terminals) uses the same subtle, auto-hide style — a thin
  themed bar that fades in on hover/focus and fades out otherwise, matching VS Code.

### Fixed

- UI: the terminal tab bar's scrollbar is visible again. It had effectively disappeared
  after the palette refresh made the thumb fainter, because the bar was pinned to a 3 px
  height; it now uses the standard scrollbar width and hover reveal.
- UI: the terminal's vertical scrollbar no longer stays permanently visible as a bright
  bar that stood out from the app's other scrollbars — it auto-hides like the rest (and
  stays pinned visible while its thumb is being dragged).
