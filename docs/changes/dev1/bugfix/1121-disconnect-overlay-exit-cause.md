### Changed

- The terminal disconnect overlay now explains _why_ a session ended instead of
  always reading "The remote process has exited". A clean logout/exit (code 0)
  shows "Session ended"; a non-zero exit surfaces the exit code; a lost
  peer/network connection reads "The connection was lost". The terminal's
  `[Process exited]` line now includes the exit code when one is available
  (#1121).

### Fixed

- Terminating a session from the Open Connections panel no longer pops an
  "unexpected disconnect" overlay — a user-initiated kill drops the tab straight
  into scrollback view mode (#1121).
