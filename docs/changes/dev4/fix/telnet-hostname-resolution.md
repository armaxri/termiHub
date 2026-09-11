### Fixed

- Telnet connections configured with a **hostname** (e.g. `router.local`,
  `bbs.example.com`) now connect. The telnet backend previously parsed
  `host:port` straight into a `SocketAddr`, which only accepts numeric IP
  literals, so any hostname failed at connect with "Invalid address" and only
  bare IPs worked. The connect path now resolves the host via DNS first, trying
  each resolved address in turn, and reports an unresolvable host as a clean
  error rather than rejecting it outright (CORE-015).
