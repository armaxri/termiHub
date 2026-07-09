### Added

- **SSH tunnel sidebar now shows live throughput.** While a tunnel is
  connected, the backend emits a `tunnel-stats-updated` event roughly every
  second carrying the tunnel's real `↑`/`↓` bytes and active-connection count,
  so the Tunnel sidebar (and Open Connections) update live instead of freezing
  at `0` for the tunnel's lifetime. Emission stops automatically once no tunnel
  is active, and a dead/errored tunnel stops reporting stats (#1248).
