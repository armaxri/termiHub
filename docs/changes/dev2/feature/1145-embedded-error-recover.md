### Fixed

- An embedded HTTP/FTP/TFTP server that failed at runtime is no longer stuck in a
  dead-end Error state. Previously the failed server kept its internal "running"
  bookkeeping, so the sidebar showed it red while clicking Start silently did
  nothing (the only escape was Delete or Edit). Start now acts as a real
  Retry — it clears the failed entry and starts the server again — so
  `Error → Stopped → Running` works. Addresses GAP G2/G9 of the embedded servers
  state-machine audit (#1145).
