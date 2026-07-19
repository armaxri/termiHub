### Added

- SSH agent forwarding (`forwardAgent`) now also applies when an SSH session is
  routed through a **deployed termiHub agent**, not just the desktop path
  (#1699). The agent reuses the core SSH backend, so the forwarded-agent channel
  is bridged to the ssh-agent local to the **agent host**; when the desktop
  reaches that host over SSH with agent forwarding enabled, the operator's keys
  chain through to the final target end to end. No local agent on the host is a
  graceful no-op and the connection still succeeds (#1719).
