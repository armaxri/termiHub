### Fixed

- Remote agents: a fast connection drop during connect no longer flickers back
  to "connected". The agent's `connectionState` now has a single writer — the
  backend `agent-state-change` event — so a late-settling connect can never
  clobber a "reconnecting" state, and the sidebar dot, tab-strip dot, and
  terminal overlay stay consistent (#1234).

### Changed

- Connecting to a remote agent now refreshes its sessions and definitions
  exactly once per connect instead of twice (#1234).
