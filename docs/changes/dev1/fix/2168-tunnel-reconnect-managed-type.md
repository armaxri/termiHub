### Fixed

- SSH tunnels with **Reconnect on disconnect** enabled now actually reconnect
  after the connection drops. The per-tunnel reconnect-backoff loop resolved the
  tunnel manager by the wrong managed type (`TunnelManager` instead of the
  registered `Arc<TunnelManager>`); because Tauri keys managed state by exact
  type, the lookup always missed and every reconnect attempt was a silent no-op,
  so `reconnectOnDisconnect` (#1246) never actually reconnected (#2168).
