### Added

- System monitoring now reports **per-core CPU usage** for monitored hosts,
  alongside the existing aggregate CPU / memory / disk / swap / network metrics.
  The monitoring dropdown surfaces a compact row of per-core mini-bars (one bar
  per logical core, height and colour tracking that core's load), shown only when
  per-core data is available. Both the cross-platform agent collector (`sysinfo`)
  and the Linux SSH `/proc/stat` collector supply the per-core figures; hosts
  that do not report them (older agents, non-Linux SSH remotes) simply omit the
  bars, degrading gracefully rather than erroring (#3178).
