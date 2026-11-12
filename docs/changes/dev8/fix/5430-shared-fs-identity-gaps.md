### Fixed

- File browser: the guard against pasting a file onto itself through another
  session now also covers sessions that log in to one SSH server as different
  users, a local server reached as `localhost` and `127.0.0.1`, and agent-hosted
  SSH sessions opened from the same saved connection. Such a paste is refused
  only when the file really is the same one on both sides, so a copy between
  users who each have their own jailed home still goes ahead (#5430).
