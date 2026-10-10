### Fixed

- File transfers: cancelling a transfer while it was still probing the
  connection or opening a channel did nothing until the underlying I/O timed
  out — which on a dead connection could be never — so the row stayed queued or
  active and kept its slot. The up-front source probes and the per-attempt
  channel opens and resume checks of SFTP, FTP, Docker, agent-hosted and
  remote-to-remote transfers now react to a cancel immediately and give up after
  the stall timeout, and the cleanup of a partial upload after a cancel is
  bounded, so a cancelled transfer settles promptly and frees its slot (#4672).
