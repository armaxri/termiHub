### Added

- The status bar now shows live system stats for SSH, Docker and WSL sessions
  that run through a remote agent (#3871). The stats come from the session's
  own remote host, container or WSL distribution; a distroless container is
  shown "via Docker stats". Only the desktop that currently controls the
  session receives them, and they stop when the session is closed, detached or
  taken over.

### Changed

- If the remote agent is too old to monitor such a session, the status bar
  says to update the agent instead of showing a monitor error.
