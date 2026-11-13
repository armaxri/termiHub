### Fixed

- An upload interrupted by a crash now resumes from its last checkpoint after
  the relaunch over SFTP and Docker: the bytes the remote file held past the
  checkpoint are trimmed off first instead of the whole file being sent again.
  FTP and agent-hosted sessions cannot shorten a remote file, so such an
  upload starts over and the transfer row says why.
- An FTP download interrupted by a crash now resumes from its last checkpoint
  after the relaunch instead of downloading the whole file again.
