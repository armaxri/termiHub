### Fixed

- A local shell tab ended with `exit 3` now writes "[Process exited with code 3]" into the
  scrollback and its overlay reads "The process exited with code 3", instead of "[Process exited]"
  and "The connection was lost". A plain `exit` reads as a normal end; a shell you ended is never
  reconnected (#5784).
