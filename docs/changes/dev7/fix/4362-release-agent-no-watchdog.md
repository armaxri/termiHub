### Fixed

- Agent: the test-only parent-death watchdog is no longer compiled into release agents, so setting
  `TERMIHUB_TEST_PARENT_PID` in an agent's environment can no longer make a shipped agent, or its
  session and registry daemons, exit abruptly. Release builds now fail CI if they contain any
  env-armed test hook (#4362).
