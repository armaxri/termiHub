### Added

- Agent-hosted **remote (`-R`)** SSH tunnel forwarding: a remote-forward tunnel
  whose run-location is a remote agent now actually forwards traffic instead of
  returning the "not yet supported" error. Per the settled endpoint semantics,
  the **SSH server** binds the listen socket (via `tcpip_forward`) and each
  incoming connection is relayed to a target resolved from the **agent** (the
  tunnel host) — SSH's own local/remote meaning is invariant, only the tunnel
  host moves. The reported reachability is "SSH server". Dynamic (`-D`) agent
  hosting remains the only follow-up; desktop-hosted tunnels are unchanged.
  (Part of #2185, Closes #2197)

### Changed

- The remote-forward engine (`RemoteForwarder`, `RemoteForwardConfig`) moved
  into `termihub-core` so the identical forwarder runs on the desktop or an
  agent — the twin of the earlier local-forward lift. Existing desktop behaviour
  is unchanged.
