### Fixed

- Agent sessions: a session daemon that hangs while its connection stays open
  is now detected. The agent and the daemon ping each other after 15 s of
  silence, and a side that answers none of four pings (75 s in all) is dropped,
  so the session is reported as lost and can be reconnected instead of looking
  alive while nothing happens. Idle sessions are never affected, and daemons
  from older agent versions keep working unchanged (#3140).
