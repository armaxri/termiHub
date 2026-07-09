### Fixed

- HTTP monitor (Network Tools): a monitor whose internal HTTP client failed to
  build no longer becomes an invisible "checking…" zombie. Previously the poll
  loop returned before its first check while the monitor still showed as running,
  so it never emitted a result and never recovered. It now emits a failed check
  (with the build error) so the monitor is shown as down/errored instead of stuck.
  Addresses gap #4 of the HTTP monitor audit (#1147).
