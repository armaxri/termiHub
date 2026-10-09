### Fixed

- Remote agent: a terminal that stops accepting input no longer freezes the agent. When a
  serial, telnet or local-shell session on an agent stopped draining what you typed, every
  other session on that agent (typing, resizing, opening, closing and listing sessions) waited
  for it. Other sessions now keep working, and input to the stuck session waits its turn and
  arrives in order. Agent shutdown also releases persistent sessions in parallel and no longer
  hangs on one unresponsive session (#4476).
