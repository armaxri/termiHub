### Fixed

- Monitoring: an agent-hosted system monitor no longer stays "Stale" forever
  after the agent stops streaming samples while the agent itself stays
  connected. The agent now reports its monitor status (live, stale,
  reconnecting, offline) to the desktop directly, and against an older agent the
  desktop resolves a long-silent "Stale" monitor to "Offline" once the agent's
  full reconnect budget (about 3.5 minutes at the default interval) has passed.
  A sample arriving later still brings the monitor back to live (#3321).
