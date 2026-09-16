### Fixed

- A resilient tab whose auto-reconnect the user stopped (or that had already
  reconnected) no longer strands in a spurious "Reconnecting" state when the
  older, superseded connect attempt errors late. A stale reconnect failure is
  now ignored unless an attempt is actually in flight, so a cancelled or
  already-connected session keeps its settled state instead of flipping back to
  a reconnecting loop with no timer running (TBE-011).
