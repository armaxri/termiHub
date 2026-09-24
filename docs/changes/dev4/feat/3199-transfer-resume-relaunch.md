### Added

- Resuming a transfer that was **restored from a previous run** now actually
  restarts it. Incomplete transfers already reappear as paused rows in the
  Transfer Queue after a restart (metadata only — never credentials); previously
  clicking Resume on such a row did nothing, because it had no live session or
  transfer behind it. Resume (and Retry) now re-attach the session from the
  stored reference, re-source the credentials from the live session at resume
  time (still never from the saved queue), and continue the SFTP transfer from
  where it left off using the existing byte-verified offset resume — competing
  for a transfer slot like any other transfer. If the session cannot be
  re-attached (not currently connected), the row moves to a clear **Failed**
  state with an honest message instead of hanging on "Resuming…" (#3199).
