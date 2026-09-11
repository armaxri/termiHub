### Fixed

- Sidebar file browser rows are now two lines so the filename gets the full
  width of the narrow sidebar: the name sits on the first line (dominant,
  truncated with an ellipsis, full name shown as a hover tooltip) with a smaller,
  muted `Modified · Size · permissions` meta line below it. The Size now shows a
  real value for files (a missing or invalid size is omitted instead of showing
  `NaN GB`, and its separator is dropped so there is never a dangling middot),
  directories show no size, and hovering the Modified value shows the absolute
  date and time (#2798).
