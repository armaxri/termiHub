### Fixed

- **SSH tunnels now detect death instead of showing green forever.** When a
  tunnel's forwarder accept loop exits or its SSH session dies, a per-tunnel
  supervisor tears the tunnel down, releases its pooled session/port, and
  transitions the row to a persisted **Error** with the cause — so a dead tunnel
  no longer sits green while leaking a pooled session and bound port (#1243).

### Added

- **Force-Reconnect** control on a connected tunnel row: tears the tunnel down
  and restarts it even if liveness has not fired yet, covering a stale-but-green
  tunnel the supervisor is slow to notice (#1243).
