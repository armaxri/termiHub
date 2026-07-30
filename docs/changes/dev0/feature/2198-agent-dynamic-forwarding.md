### Added

- Agent-hosted **dynamic (`-D`, SOCKS5)** SSH tunnel forwarding: a dynamic
  tunnel whose run-location is a remote agent now actually proxies traffic
  instead of returning the "not yet supported" error, completing the
  local/remote/dynamic trilogy for agent-hosted tunnels. Per the settled
  endpoint semantics, the **SOCKS5 proxy listen socket binds on the agent**
  (loopback by default) and each proxied connection's target — chosen by the
  SOCKS client per-connection — is reached from the **SSH server's** network. The
  reported reachability is loopback-safe: an agent loopback bind is "agent only",
  a widened bind is "agent LAN"; the bind is never silently widened.
  (Part of #2185, Closes #2198)

### Changed

- The dynamic (SOCKS5) forward engine (`DynamicForwarder`,
  `DynamicForwardConfig`) moved into `termihub-core` so the identical forwarder
  runs on the desktop or an agent — the twin of the earlier local- and
  remote-forward lifts. Desktop-hosted dynamic tunnels are unchanged.
