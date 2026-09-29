### Changed

- Agent-hosted SSH and serial sessions now show the same connection-failure
  hint as direct ones (#3751). A busy, missing or permission-denied serial port,
  an SSH connect timeout, and an unreachable SSH agent are reported with their
  typed reason from the agent's session daemon, so the overlay explains the
  cause instead of showing a generic remote error. The agent protocol is now
  0.18.0 (additive: `connection.create` errors may carry
  `data.connect_failure`); older agents and desktops keep working as before.
