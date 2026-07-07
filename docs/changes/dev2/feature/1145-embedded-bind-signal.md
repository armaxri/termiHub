### Fixed

- Embedded HTTP/FTP/TFTP servers now report **Running** only after their
  listening socket is actually bound. Previously the sidebar item turned green
  the moment the server thread was spawned, so a late bind failure left it
  briefly green before flipping to red — or stuck green while nothing was
  listening. Each server thread now confirms (or rejects) its bind back to the
  manager, which emits **Running** on confirmation and **Error** (with the
  reason) on failure, leaving no stale "running" entry behind. Addresses GAP G3
  of the embedded servers state-machine audit (#1145).
