### Fixed

- A closed terminal tab can no longer briefly reappear as a phantom "Connecting…"
  entry. A late or out-of-order lifecycle event (a link drop, connect failure,
  disconnect, reconnect, or agent session-lost) arriving after the tab was already
  removed used to lazily re-create its session-lifecycle region entry; only the
  initial connect now creates an entry, and every later fold is a no-op for a
  session the region no longer tracks (SM-006).
