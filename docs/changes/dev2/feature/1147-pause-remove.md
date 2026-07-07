### Added

- HTTP monitors can now be **paused and resumed**. Pausing suspends polling
  while keeping the monitor listed (and its poll loop alive) so it can be
  resumed instantly with the same configuration and history; a paused monitor
  shows a "paused" state in the Network Tools panel, the sidebar, and the Open
  Connections panel (audit gap #5, #1147).

### Changed

- **Stop and Remove are now separate actions for HTTP monitors.** _Stop_ cancels
  the poll loop but keeps the monitor listed (as stopped) and preserves its
  saved configuration so it can be resumed or auto-restarts on the next launch.
  _Remove_ deletes the monitor and its persisted config entirely. Previously
  "Stop" silently destroyed the monitor and its configuration (audit gap #6,
  #1147).
