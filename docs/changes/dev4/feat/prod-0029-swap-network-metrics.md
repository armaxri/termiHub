### Added

- System monitoring now reports **swap usage** and **network throughput** for
  monitored hosts, alongside the existing CPU / memory / disk metrics. The
  status bar shows a compact swap percentage (only when the host has swap
  configured) and live receive/transmit rates (`Net ↓… ↑…`). Both the
  cross-platform agent collector (`sysinfo`) and the Linux SSH `/proc` collector
  supply the new fields; hosts that do not report them (older agents, non-Linux
  SSH remotes) simply show `0`, degrading gracefully rather than erroring. This
  also makes the README's long-standing "network stats" claim actually true
  (PROD-0029).
