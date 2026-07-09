### Fixed

- Embedded TFTP server: an in-flight file transfer now aborts promptly when the
  server is stopped (or the app quits). Previously each transfer ran in a
  detached thread that ignored the server shutdown flag, so it could keep a UDP
  socket and file handle open for up to ~25 seconds after stop (5 retries ×
  5 s ACK timeout), leaving the port busy with nothing shown in the UI. The
  shutdown flag is now checked in the transfer send/receive loops (#1145).
