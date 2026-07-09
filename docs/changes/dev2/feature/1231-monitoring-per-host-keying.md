### Added

- **Multiple hosts can now be monitored simultaneously.** Remote system
  monitoring state is keyed per host/session instead of a single global monitor,
  so switching tabs no longer tears down the previous host's monitor — each
  monitored host keeps updating independently and the status bar shows the
  active tab's stats (#1231).

### Changed

- The **Open Connections** panel now lists monitored hosts individually — one
  killable row per host — instead of a single combined Monitoring row. Each row
  has its own Kill (and shows a "stale" hint when a host's connection dropped),
  and the section has a Kill All (#1231).
