### Fixed

- Terminal: when a plugin's sandboxed process crashes, stops responding, runs
  out of memory or sends invalid data, the notice no longer covers the whole
  terminal with a dimmed backdrop. It is now the same full-width strip at the
  top of the terminal as other ended sessions, pushing the output down so the
  scrollback stays readable; Restart session and Close tab are unchanged
  (#5916).
