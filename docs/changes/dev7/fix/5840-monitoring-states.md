### Changed

- Monitoring: the host menu now says what "Pause monitoring" and "Stop
  monitoring" do in a muted line under each, and Stop uses a stop icon instead
  of an empty square that read as an unticked checkbox (#5840).
- Monitoring: the host menu is headed by the host as you configured it (the
  same name as the status-bar chip); the machine's own hostname is a muted
  detail, shown only when it differs (#5840).
- Monitoring: the compact sparklines in the host menu all start at the same
  point, so they read on one time axis (#5840).

### Fixed

- Monitoring: a connected host that has not sent stats yet no longer shows a
  bare host chip. The status bar says "Waiting for stats…", a muted
  "Monitoring unavailable" with the reason in its tooltip, or that monitoring
  is not supported on the host (#5840).
- Network Tools: stopping or pausing an HTTP monitor from its tab now updates
  the sidebar row right away, showing Stopped or Paused instead of a stale red
  Down (#5814).
