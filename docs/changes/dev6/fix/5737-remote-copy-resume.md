### Fixed

- A copy between two remote sessions (for example SFTP to SFTP, or a Docker
  container to an SFTP server) interrupted by a crash now resumes from its last
  checkpoint after the relaunch: the bytes the destination held past the
  checkpoint are trimmed off first instead of the whole file being copied
  again. A destination that cannot shorten a file (an agent-hosted session)
  starts over and the transfer row says why.
