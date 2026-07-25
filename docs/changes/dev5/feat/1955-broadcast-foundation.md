### Added

- Broadcast input (foundation): a new **Broadcast Input** toggle (Radio icon) in
  the terminal-view toolbar mirrors typed input from the active terminal to every
  other connected terminal in real time. Click once to start (all-terminals
  scope), click again to stop; closing the source tab also ends broadcast. Only
  connected terminal sessions receive the input — disconnected, connecting, and
  non-terminal tabs are skipped silently. This is the base for the scope
  dropdown, visual indicators, and keyboard shortcut that follow (#1955,
  epic #1954).
