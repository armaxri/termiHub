### Added

- **Host-wide agent registry daemon.** An agent host now runs a single per-user registry
  (`termihub-agent --registry-daemon`) that every agent worker registers its client with, so a
  desktop can see the other desktops attached to the same host — including desktops that hold no
  sessions at all. It is a new role on the existing daemon substrate, so it opens **no network
  socket** (unix domain socket / Windows named pipe, current-user-only), survives an agent binary
  swap, and works on all three platforms. The registry is optional infrastructure: if it is absent,
  cannot start, or restarts, agents keep working and simply report what they can see themselves.

### Changed

- **`agent.list_connections` now returns the host-wide client set** rather than only the client of
  the agent process that answered. When no registry is reachable it falls back to the answering
  process's own clients — the previous behaviour — rather than reporting an empty host.
