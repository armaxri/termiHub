### Fixed

- Agents: connecting to a remote agent no longer freezes the app. While one agent connects
  (including while it waits on a login prompt), other agents, their terminals and the agent
  list keep responding; a second connect to the same agent is refused instead of queueing,
  and disconnecting an agent that is still connecting cancels the connect (#4304).
- Agents: an agent that starts but never answers the handshake now fails the connect or
  reconnect attempt after the connect timeout instead of staying in "Connecting" or
  "Reconnecting" forever (#4304).
