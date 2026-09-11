### Fixed

- SSH connections with an out-of-range numeric port (above 65535) no longer
  silently connect to a wrong, truncated port. A numeric `70000` previously
  wrapped to `4464` (and `65536` to `0`); it is now rejected and falls back to
  the default port 22, matching how a `"70000"` string port was already handled
  (CORE-006).
- The interactive SSH shell now tears the session down when a keystroke or
  terminal-resize can no longer be written to the channel, instead of silently
  discarding the failure. Previously a failed write left the terminal looking
  live while swallowing input; the session now ends so the failure is visible
  (CORE-007).
