### Added

- The file browser now works for SSH, Docker, FTP and WSL sessions that run
  through a remote agent (#3242). It shows the files of the session's own
  remote host, container, FTP server or WSL distribution, not the agent host's.
  Only the desktop that currently controls the session can browse it. Large
  downloads and uploads move in small pieces, so the session's terminal stays
  responsive while they run.

### Changed

- If the remote agent is too old to browse such a session, the file browser
  says to update the agent instead of showing an error.
