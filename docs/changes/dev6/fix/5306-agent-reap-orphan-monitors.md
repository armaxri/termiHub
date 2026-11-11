### Fixed

- Agent: a `--listen` agent no longer keeps polling monitoring targets forever
  after its desktop goes away for good. Monitors still survive a reconnect, but
  once no client has been connected for a grace period (5 minutes by default,
  `TERMIHUB_AGENT_MONITORING_ORPHAN_GRACE_SECS` to override) they are stopped. A
  desktop that connects later subscribes again as usual (#5306).
