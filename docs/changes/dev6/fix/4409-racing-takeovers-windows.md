### Fixed

- When two desktops take over the same agent session at almost the same moment,
  the one that loses now always connects and is then told the session was taken
  over. Previously, on a busy machine (seen on Windows), the loser could instead
  fail to connect with "Daemon closed connection during handshake" (#4409).
