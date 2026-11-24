### Fixed

- Terminal: the disconnected / session-ended notice no longer floats over the
  terminal and hides its first or last output lines. It is now a full-width
  strip at the top of the terminal that pushes the output down, so every line
  stays readable and selectable. The reconnect strip and the "Session ended" /
  "Agent disconnected" banner push the output down the same way (#5908).
- Terminal: a process that exits is no longer shown as a lost connection. A
  local shell that exits with a code reads "Process exited (code N)" with a
  process icon and Restart; a normal exit reads "Session ended" with Restart.
  "Session disconnected" and the no-wifi icon are kept for a real network
  drop (#5910).
