### Fixed

- A corrupt `last-session.json` is now preserved to a `.bak` sidecar on startup instead of
  being silently discarded. Previously a session-restore file that failed to parse was ignored
  as "no session" and then overwritten by the next layout change, losing any recoverable data.
