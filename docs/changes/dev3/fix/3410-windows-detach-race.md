### Fixed

- Agent: re-opening a terminal right after closing its tab could be refused as
  "held by another desktop" although nobody else held it. Detaching sent the
  detach request to the session daemon but returned before the daemon had
  processed it, so an immediate re-attach or holder probe could still find this
  worker's own connection attached — most often on Windows, but on every
  platform. Detach now waits (bounded) until the daemon has released the
  connection, which every daemon version signals by closing it, so the session
  is reliably free the moment detach returns (#3410).
