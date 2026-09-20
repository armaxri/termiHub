### Added

- Local shell sessions now support system monitoring. The status bar's live
  CPU / memory / swap / disk / network readout — previously available only for
  SSH connections — now works for connections to the local machine, with no
  agent required. It reuses the same cross-platform `sysinfo`-backed collector
  the agent uses for self-monitoring, so Linux, macOS, and Windows are all
  covered, and honours the existing pause / interval / cancel controls and the
  Connecting → Live → Stale lifecycle indicator (PROD-0022).
