### Fixed

- Remote agents: a manual Connect or Reconnect while termiHub is reconnecting an
  agent after a coordinated update now takes over at once, instead of failing
  with "already connecting" while a reconnect attempt is in progress (#4621).
