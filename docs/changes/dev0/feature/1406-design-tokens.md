### Fixed

- Defined the previously missing `--radius-full` and `--text-muted` design
  tokens, which were referenced by several surfaces but never declared and so
  resolved to invalid/zero values. Pill badges and progress bars in the Open
  Connections panel and the X server setup dialog now render with their intended
  fully rounded corners, and muted/incidental text in those surfaces plus the
  status bar now uses a proper per-theme muted color (light + dark, including
  the Solarized variants) instead of a broken fallback (#1406).
