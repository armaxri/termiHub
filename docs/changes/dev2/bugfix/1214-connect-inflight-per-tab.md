### Fixed

- Terminal: closing a tab while a connection is still being established no longer
  leaves an orphaned backend handshake when an overlapping connect attempt (from a
  retry/reconnect) had already settled. The connect in-flight guard is now tracked
  per attempt instead of as a single shared flag, so tearing down the tab reliably
  cancels the attempt that is actually still connecting (#1214).
