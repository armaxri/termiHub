### Added

- Agent-hosted SSH tunnel forwarding: a tunnel whose run-location is a remote
  agent now actually forwards traffic on the agent instead of returning the
  "agent-hosted tunnels are not yet supported" error. The agent opens its own
  SSH session to the tunnel's "via" server and binds the listen socket on the
  agent (loopback by default), so the SSH hop runs in-network. This first slice
  covers **local (`-L`)** forwarding; remote (`-R`) and dynamic (`-D`) agent
  hosting remain follow-ups (a clear error is shown if selected on an agent).
  Desktop-hosted tunnels are unchanged. (Part of #2185)

### Changed

- The local-forward engine (`LocalForwarder`, its channel-opener seam, and the
  `LocalForwardConfig`/`TunnelStats` types) moved into `termihub-core` so the
  identical forwarder runs on the desktop or an agent. Existing desktop behaviour
  is unchanged.
