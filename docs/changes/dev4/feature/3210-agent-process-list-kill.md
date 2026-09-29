### Added

- The process table now works for SSH, Docker and WSL sessions that run
  through a remote agent (#3210). It lists the processes of the session's own
  remote host, container or WSL distribution, and every signal from the kill
  menu reaches the chosen process there. Only the desktop that currently
  controls the session can list or stop its processes.

### Changed

- If the remote agent is too old to manage processes for such a session, the
  process table says to update the agent instead of showing an error.
