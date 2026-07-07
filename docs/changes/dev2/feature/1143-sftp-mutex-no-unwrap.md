### Fixed

- A crashing SFTP operation no longer takes down every subsequent SFTP command.
  The SFTP command layer previously locked the session mutex with `.unwrap()`, so
  if any transfer or file op panicked while holding the lock, the poisoned mutex
  made every later SFTP command abort the whole process. Locks now map a poisoned
  session to a recoverable error, so the app reports a normal failure and keeps
  running (audit gap C1, #1143).
