### Changed

- Agent: the agent's log lines for an agent-hosted session now carry the same
  session id as the desktop's `termihub.log`, so one session can be followed
  across both logs by filtering on a single id. Older agents and desktops keep
  working unchanged (#3085).
