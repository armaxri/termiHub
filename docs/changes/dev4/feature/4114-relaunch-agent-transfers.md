### Added

- Queued uploads and downloads on agent-hosted sessions now resume after
  termiHub restarts (#4114). Until the agent is reconnected the row stays
  paused with "Agent session unavailable — reconnect the agent and open the
  connection to resume"; once you reopen the connection on that agent, the
  transfer continues from its verified offset by itself. It only ever resumes
  on the same agent and the same saved connection, never into another file
  system.
