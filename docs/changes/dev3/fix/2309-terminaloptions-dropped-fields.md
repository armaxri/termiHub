### Fixed

- Per-connection terminal options no longer vanish after saving. The
  `logToFile` / `logTimestamps` (#1960), `lineHeight`, and per-connection
  `syntaxHighlighting` (#1696) settings were silently discarded when a
  connection was saved, because the backend's `TerminalOptions` struct did not
  model them — so they were gone on the next app restart. The backend now
  persists all four (Closes #2309).
