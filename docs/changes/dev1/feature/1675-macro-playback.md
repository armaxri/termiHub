### Added

- Play a saved macro back into the active terminal: a "Play Macro" button in the
  terminal toolbar opens a picker to choose a macro and a timing mode — real-time
  (honor the recorded delays), fixed (a constant delay per step), or instant (no
  delay). Each stored macro also appears in the command palette as a `Run Macro: <name>`
  entry that replays it with real-time timing. Playback shows live progress, can be
  cancelled mid-run (the toolbar button turns into a stop control), and fails with a
  recoverable notification when the target terminal is not connected (#1675).
